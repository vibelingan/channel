import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from '../../../packages/db/src/catalog-image-references.ts';
import { JsonFileAdapter } from './json-adapter.ts';

function fixture(t: { after(callback: () => void): void }, shared = false) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-reference-snapshot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const plan = buildCatalogImageReferencePlan(
    '1'.repeat(64),
    [],
    shared ? ['image', 'other'] : ['image'],
  );
  const image = (id: string, index: number) => ({
    _id: id,
    publishedRefCount: 0,
    storagePath: 'private/image.png',
    imageMutationOwner: 'unchanged',
    status: 'active',
    catalogPublishedReferenceLedger: {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 0,
      pending: [catalogImageReferenceEntry(plan, index)],
    },
  });
  writeFileSync(
    file,
    JSON.stringify({
      images: shared ? [image('image', 0), image('other', 1)] : [image('image', 0)],
      catalogDetailApprovals: [plan.proof],
    }),
  );
  return {
    file,
    plan,
    adapter: new JsonFileAdapter(file),
    bytes: () => readFileSync(file, 'utf8'),
  };
}
const read = { action: 'read' as const, imageId: 'image' };
const settle = { ...read, action: 'settle' as const };

test('JSON snapshot read is consistent and leaves file bytes and mtime unchanged', async (t) => {
  const h = fixture(t);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const result = await h.adapter.readCatalogImageReference(read);
  assert.ok(result.state === 'counted');
  assert.equal(result.effectiveCount, 1);
  assert.equal(result.image.publishedRefCount, 0);
  assert.equal(result.settled, false);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

test('JSON reference settlement survives reopen and never applies its proof twice', async (t) => {
  const h = fixture(t);
  const result = await h.adapter.readCatalogImageReference(settle);
  assert.ok(result.state === 'counted' && result.settled);
  assert.equal(result.image.publishedRefCount, 1);
  assert.equal(result.image.imageMutationOwner, 'unchanged');
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const replay = await new JsonFileAdapter(h.file).readCatalogImageReference(settle);
  assert.ok(replay.state === 'counted');
  assert.equal(replay.effectiveCount, 1);
  assert.equal(replay.settled, false);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

for (const action of ['read', 'settle'] as const)
  test(`JSON concurrent settle/${action} keeps one effective reference`, async (t) => {
    const h = fixture(t);
    const other = new JsonFileAdapter(h.file);
    const results = await Promise.allSettled([
      h.adapter.readCatalogImageReference(settle),
      other.readCatalogImageReference({ ...read, action }),
    ]);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    let writes = 0;
    for (const result of results) {
      assert.ok(result.status === 'fulfilled' && result.value.state === 'counted');
      assert.equal(result.value.effectiveCount, 1);
      if (result.value.settled) writes++;
    }
    assert.equal(writes, 1);
    assert.equal((await new JsonFileAdapter(h.file).get('images', 'image'))?.publishedRefCount, 1);
  });

test('JSON shared proof can settle different images without deleting commit truth', async (t) => {
  const h = fixture(t, true);
  const other = new JsonFileAdapter(h.file);
  const settled = await Promise.allSettled([
    h.adapter.readCatalogImageReference(settle),
    other.readCatalogImageReference({ ...settle, imageId: 'other' }),
  ]);
  assert.ok(settled.every((result) => result.status === 'fulfilled'));
  const rows = JSON.parse(h.bytes());
  assert.equal(rows.images.length, 2);
  assert.ok(rows.images.every((row: { publishedRefCount: number }) => row.publishedRefCount === 1));
  assert.equal(rows.catalogDetailApprovals.length, 1);
});

test('JSON failed persistence rolls back the in-memory row as well as leaving the file unchanged', async (t) => {
  const h = fixture(t);
  const before = h.bytes();
  const persist = Reflect.get(h.adapter, 'persist');
  try {
    Reflect.set(h.adapter, 'persist', () => {
      throw Error('owned reference rename refused');
    });
    await assert.rejects(
      h.adapter.readCatalogImageReference(settle),
      /owned reference rename refused/,
    );
    assert.equal(h.bytes(), before);
    const result = await h.adapter.readCatalogImageReference(read);
    assert.ok(result.state === 'counted');
    assert.equal(result.effectiveCount, 1);
    assert.equal(result.image.publishedRefCount, 0);
  } finally {
    Reflect.set(h.adapter, 'persist', persist);
  }
  const resumed = await new JsonFileAdapter(h.file).readCatalogImageReference(settle);
  assert.ok(resumed.state === 'counted' && resumed.settled);
  assert.equal(resumed.effectiveCount, 1);
});

test('JSON reference command is captured before waiting for its mutation lock', async (t) => {
  const h = fixture(t, true);
  const pending = h.adapter.readCatalogImageReference(settle);
  const original: { action: 'read' | 'settle'; imageId: string } = { ...settle };
  const delayed = new JsonFileAdapter(h.file).readCatalogImageReference(original);
  original.action = 'read';
  original.imageId = 'other';
  await pending;
  const result = await delayed;
  assert.ok(result.state === 'counted');
  assert.equal(result.image._id, 'image');
  assert.equal(result.effectiveCount, 1);
  assert.equal((await new JsonFileAdapter(h.file).get('images', 'other'))?.publishedRefCount, 0);
});

for (const damaged of ['counter', 'ledger', 'proof'] as const)
  test(`JSON reference ${damaged} corruption fails without overwriting storage`, async (t) => {
    const h = fixture(t);
    const rows = JSON.parse(h.bytes());
    if (damaged === 'counter') rows.images[0].publishedRefCount = '1';
    if (damaged === 'ledger') rows.images[0].catalogPublishedReferenceLedger = null;
    if (damaged === 'proof') rows.catalogDetailApprovals[0].treeRoot = '0'.repeat(64);
    writeFileSync(h.file, JSON.stringify(rows));
    const before = h.bytes();
    await assert.rejects(new JsonFileAdapter(h.file).readCatalogImageReference(settle));
    assert.equal(h.bytes(), before);
  });

test('JSON cancelled-reference settlement releases its slot and preserves the counter across reopen', async (t) => {
  const h = fixture(t);
  const rows = JSON.parse(h.bytes());
  rows.catalogDetailApprovals = [catalogImageReferenceCancelProof(h.plan.proof)];
  writeFileSync(h.file, JSON.stringify(rows));
  const result = await h.adapter.readCatalogImageReference(settle);
  assert.ok(result.state === 'counted' && result.settled);
  assert.equal(result.effectiveCount, 0);
  assert.equal(result.image.publishedRefCount, 0);
  const ledger = result.image.catalogPublishedReferenceLedger;
  assert.ok(ledger && typeof ledger === 'object');
  assert.deepEqual(Reflect.get(ledger, 'pending'), []);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const replay = await new JsonFileAdapter(h.file).readCatalogImageReference(settle);
  assert.equal(replay.settled, false);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.equal(JSON.parse(before).catalogDetailApprovals.length, 1);
});

for (const action of ['read', 'settle'] as const)
  test(`JSON cancelled-reference settle/${action} keeps a cancelled addition inactive`, async (t) => {
    const h = fixture(t);
    const rows = JSON.parse(h.bytes());
    rows.catalogDetailApprovals = [catalogImageReferenceCancelProof(h.plan.proof)];
    writeFileSync(h.file, JSON.stringify(rows));
    const other = new JsonFileAdapter(h.file);
    const results = await Promise.allSettled([
      h.adapter.readCatalogImageReference(settle),
      other.readCatalogImageReference({ ...read, action }),
    ]);
    let writes = 0;
    for (const result of results) {
      assert.ok(result.status === 'fulfilled' && result.value.state === 'counted');
      assert.equal(result.value.effectiveCount, 0);
      if (result.value.settled) writes++;
    }
    assert.equal(writes, 1);
    assert.equal((await new JsonFileAdapter(h.file).get('images', 'image'))?.publishedRefCount, 0);
  });
