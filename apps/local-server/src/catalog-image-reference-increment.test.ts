import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from '../../../packages/db/src/catalog-image-references.ts';
import { JsonFileAdapter } from './json-adapter.ts';

function fixture(
  t: { after(fn: () => void): void },
  base: unknown,
  changes: Array<{ delta: 1 | -1; kind: 'commit' | 'cancel' | 'missing' }> = [],
) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-reference-adjust-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const plans = changes.map((change, index) =>
    buildCatalogImageReferencePlan(
      (index + 1).toString(16).padStart(64, '0'),
      change.delta === -1 ? ['image'] : [],
      change.delta === 1 ? ['image'] : [],
    ),
  );
  const image: CollectionDoc = {
    _id: 'image',
    storagePath: 'private/same.png',
    imageMutationOwner: 'keep',
    privateMetadata: { nested: ['keep'] },
    publishedRefCount: base,
    catalogPublishedReferenceLedger: {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
    },
  };
  const rows: Record<string, CollectionDoc[]> = {
    images: [image],
    catalogDetailApprovals: plans.flatMap((plan, index) =>
      changes[index]?.kind === 'missing'
        ? []
        : [
            changes[index]?.kind === 'cancel'
              ? catalogImageReferenceCancelProof(plan.proof)
              : plan.proof,
          ],
    ),
  };
  const save = () => writeFileSync(file, JSON.stringify(rows));
  save();
  return {
    file,
    rows,
    image,
    plans,
    save,
    adapter: new JsonFileAdapter(file),
    bytes: () => readFileSync(file, 'utf8'),
  };
}
for (const delta of [-1, 1] as const)
  test(`JSON old ${delta} delta settles a committed opposite reference in one write`, async (t) => {
    const h = fixture(t, delta === -1 ? 0 : 1, [{ delta: delta === -1 ? 1 : -1, kind: 'commit' }]);
    assert.equal(
      await h.adapter.incrementField('images', 'image', 'publishedRefCount', delta),
      delta === -1 ? 0 : 1,
    );
    const actual = await h.adapter.get('images', 'image');
    assert.ok(actual);
    assert.equal(actual.publishedRefCount, delta === -1 ? 0 : 1);
    assert.deepEqual(actual.catalogPublishedReferenceLedger, {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 5,
      pending: [],
    });
    assert.equal(actual.imageMutationOwner, 'keep');
    assert.deepEqual(actual.privateMetadata, { nested: ['keep'] });
    assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals.length, 1);
  });
test('JSON old delta preserves cancelled and missing shared reference semantics', async (t) => {
  const h = fixture(t, 1, [
    { delta: 1, kind: 'commit' },
    { delta: -1, kind: 'cancel' },
    { delta: 1, kind: 'missing' },
  ]);
  assert.equal(await h.adapter.incrementField('images', 'image', 'publishedRefCount', -1), 1);
  const actual = await h.adapter.get('images', 'image');
  assert.ok(actual);
  assert.deepEqual(actual.catalogPublishedReferenceLedger, {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 5,
    pending: [catalogImageReferenceEntry(h.plans[2] ?? assert.fail(), 0)],
  });
});
for (const damage of ['ledger', 'counter', 'proof'] as const)
  test(`JSON old delta refuses corrupt ${damage} without changing bytes`, async (t) => {
    const h = fixture(t, 0, [{ delta: 1, kind: 'commit' }]);
    if (damage === 'ledger')
      h.image.catalogPublishedReferenceLedger = { version: 'unknown', epoch: 4, pending: [] };
    if (damage === 'counter') h.image.publishedRefCount = 0.5;
    if (damage === 'proof') {
      const proof = h.rows.catalogDetailApprovals?.[0];
      assert.ok(proof);
      proof.kind = 'unknown';
    }
    h.save();
    const before = h.bytes();
    await assert.rejects(h.adapter.incrementField('images', 'image', 'publishedRefCount', 1));
    assert.equal(h.bytes(), before);
  });
test('JSON zero delta with no terminal result performs no file write', async (t) => {
  const h = fixture(t, 0, [{ delta: 1, kind: 'missing' }]);
  utimesSync(h.file, new Date(1000), new Date(1000));
  const before = h.bytes();
  assert.equal(await h.adapter.incrementField('images', 'image', 'publishedRefCount', 0), 0);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});
test('JSON absent legacy reference counter stays absent instead of assuming zero', async (t) => {
  const h = fixture(t, 0);
  Reflect.deleteProperty(h.image, 'publishedRefCount');
  Reflect.deleteProperty(h.image, 'catalogPublishedReferenceLedger');
  h.save();
  const before = h.bytes();
  assert.equal(await h.adapter.incrementField('images', 'image', 'publishedRefCount', 1), null);
  assert.equal(h.bytes(), before);
  assert.equal(
    Object.hasOwn((await h.adapter.get('images', 'image')) ?? assert.fail(), 'publishedRefCount'),
    false,
  );
});

for (const action of ['increment', 'settle', 'read'] as const)
  test(`JSON simultaneous old delta/${action} preserves every shared reference`, async (t) => {
    const h = fixture(t, 0, [{ delta: 1, kind: 'commit' }]);
    const other = new JsonFileAdapter(h.file);
    const results = await Promise.allSettled([
      h.adapter.incrementField('images', 'image', 'publishedRefCount', 1),
      action === 'increment'
        ? other.incrementField('images', 'image', 'publishedRefCount', 1)
        : other.readCatalogImageReference({ imageId: 'image', action }),
    ]);
    for (const result of results) assert.equal(result.status, 'fulfilled');
    const final = await new JsonFileAdapter(h.file).readCatalogImageReference({
      imageId: 'image',
      action: 'read',
    });
    assert.ok(final.state === 'counted');
    assert.equal(final.effectiveCount, action === 'increment' ? 3 : 2);
    assert.equal(final.image.publishedRefCount, action === 'increment' ? 3 : 2);
    assert.deepEqual(
      Reflect.get(Object(final.image.catalogPublishedReferenceLedger), 'pending'),
      [],
    );
    assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals.length, 1);
  });
test('JSON old delta never edits OEM or other counter semantics', async (t) => {
  const h = fixture(t, 0);
  assert.equal(await h.adapter.incrementField('images', 'image', 'otherCount', 1), 1);
  assert.equal((await h.adapter.get('images', 'image'))?.publishedRefCount, 0);
});
for (const delta of [-1, Number.MAX_SAFE_INTEGER + 1, 0.5])
  test(`JSON invalid reference delta ${delta} cannot persist`, async (t) => {
    const h = fixture(t, 0);
    const before = h.bytes();
    await assert.rejects(h.adapter.incrementField('images', 'image', 'publishedRefCount', delta));
    assert.equal(h.bytes(), before);
  });
test('JSON zero adjustment cleans pending proofs and survives independent reopen', async (t) => {
  const h = fixture(t, 0, [{ delta: 1, kind: 'commit' }]);
  assert.equal(await h.adapter.incrementField('images', 'image', 'publishedRefCount', 0), 1);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  assert.equal(
    await new JsonFileAdapter(h.file).incrementField('images', 'image', 'publishedRefCount', 0),
    1,
  );
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

test('JSON reference adjustment restores its in-memory store after a persistence failure', async (t) => {
  const h = fixture(t, 0, [{ delta: 1, kind: 'commit' }]);
  const before = h.bytes();
  const memory = structuredClone(Reflect.get(h.adapter, 'store'));
  Object.defineProperty(h.adapter, 'persist', {
    configurable: true,
    value() {
      throw new Error('injected file persistence failure');
    },
  });
  await assert.rejects(
    h.adapter.incrementField('images', 'image', 'publishedRefCount', 1),
    /injected file persistence failure/,
  );
  assert.equal(h.bytes(), before);
  assert.deepEqual(Reflect.get(h.adapter, 'store'), memory);
  Reflect.deleteProperty(h.adapter, 'persist');
  assert.equal(await h.adapter.incrementField('images', 'image', 'publishedRefCount', 1), 2);
  assert.equal((await new JsonFileAdapter(h.file).get('images', 'image'))?.publishedRefCount, 2);
});
