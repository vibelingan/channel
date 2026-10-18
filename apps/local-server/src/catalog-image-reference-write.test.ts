import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backfillPublishedRefCounts, setAdapter } from '@vibelingan-channel/db';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
} from '../../../packages/db/src/catalog-image-references.ts';
import { handlePublicApiEvent } from '../../functions/public-api/src/http-adapter.ts';
import { JsonFileAdapter } from './json-adapter.ts';
function fixture(t: { after(fn: () => void): void }, withLedger = true) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-reference-write-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const plan = buildCatalogImageReferencePlan('1'.repeat(64), [], ['image']);
  const ledger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: [catalogImageReferenceEntry(plan, 0)],
  };
  const image = {
    _id: 'image',
    name: 'original',
    status: 'active',
    mimeType: 'image/png',
    data: 'aGVsbG8=',
    publishedRefCount: 0,
    ...(withLedger ? { catalogPublishedReferenceLedger: ledger } : {}),
  };
  writeFileSync(
    file,
    JSON.stringify({
      images: [image],
      products: [{ _id: 'p', name: 'P', category: 'wired', published: true, imageIds: ['image'] }],
      catalogDetailApprovals: withLedger ? [plan.proof] : [],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  return { file, adapter, plan, ledger, bytes: () => readFileSync(file, 'utf8') };
}
test('old backfill does not duplicate a committed pending reference', async (t) => {
  const h = fixture(t);
  const before = h.bytes();
  await backfillPublishedRefCounts();
  assert.equal((await h.adapter.get('images', 'image'))?.publishedRefCount, 0);
  assert.equal(h.bytes(), before);
  const read = await h.adapter.readCatalogImageReference({ action: 'read', imageId: 'image' });
  assert.ok(read.state === 'counted');
  assert.equal(read.effectiveCount, 1);
});
test('backfill followed by an actual old unpublish cannot leave an image public', async (t) => {
  const h = fixture(t);
  await backfillPublishedRefCounts();
  await h.adapter.update('products', 'p', { published: false });
  assert.equal(await h.adapter.incrementField('images', 'image', 'publishedRefCount', -1), 0);
  const response = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/images/image' },
    { jwtSecret: 'reference-write-fixture' },
  );
  assert.equal(response.statusCode, 404, response.body);
});
for (const method of ['update', 'upsert'] as const)
  test(`ordinary image ${method} cannot reset a managed base`, async (t) => {
    const h = fixture(t);
    const before = h.bytes();
    await assert.rejects(
      method === 'update'
        ? h.adapter.update('images', 'image', { publishedRefCount: 1 })
        : h.adapter.upsertDocWithId('images', 'image', { publishedRefCount: 1 }),
    );
    assert.equal(h.bytes(), before);
  });
for (const method of ['create', 'update', 'upsert'] as const)
  test(`ordinary image ${method} cannot introduce or replace a reference ledger`, async (t) => {
    const h = fixture(t);
    const before = h.bytes();
    const data = {
      catalogPublishedReferenceLedger: {
        version: 'catalog-image-reference-ledger-v1',
        epoch: 99,
        pending: [],
      },
    };
    await assert.rejects(
      method === 'create'
        ? h.adapter.create('images', data)
        : method === 'update'
          ? h.adapter.update('images', 'image', data)
          : h.adapter.upsertDocWithId('images', 'image', data),
    );
    assert.equal(h.bytes(), before);
  });
test('ordinary legacy counter write refuses a malformed numeric value', async (t) => {
  const h = fixture(t, false);
  const before = h.bytes();
  await assert.rejects(h.adapter.update('images', 'image', { publishedRefCount: '1' }));
  assert.equal(h.bytes(), before);
});
for (const method of ['update', 'upsert'] as const)
  test(`lease-protected image ${method} cannot reset a managed base`, async (t) => {
    const h = fixture(t);
    const now = '2026-10-18T00:00:00.000Z';
    const grant = await h.adapter.acquireAlibabaSyncLease('c', 'holder', now, 60000);
    assert.equal(grant.result, 'granted');
    assert.ok(grant.result === 'granted');
    const guard = { connectionId: 'c', holder: 'holder', fence: grant.fence, now };
    const before = h.bytes();
    await assert.rejects(
      method === 'update'
        ? h.adapter.updateDocWithAlibabaLease('images', 'image', { publishedRefCount: 1 }, guard)
        : h.adapter.upsertDocWithAlibabaLease(
            'images',
            'image',
            { publishedRefCount: 1 },
            {},
            guard,
          ),
    );
    assert.equal(h.bytes(), before);
  });
for (const method of ['update', 'upsert'] as const)
  test(`ordinary image ${method} keeps a legal metadata patch and its managed references`, async (t) => {
    const h = fixture(t);
    const result =
      method === 'update'
        ? await h.adapter.update('images', 'image', { name: 'renamed' })
        : await h.adapter.upsertDocWithId(
            'images',
            'image',
            { name: 'renamed' },
            { catalogPublishedReferenceLedger: { unused: true } },
          );
    assert.ok(result);
    assert.equal(result.name, 'renamed');
    assert.equal(result.publishedRefCount, 0);
    assert.deepEqual(result.catalogPublishedReferenceLedger, h.ledger);
  });

test('backfill observes a ledger attached after its scan at the actual write boundary', async (t) => {
  const h = fixture(t, false);
  let attached = false;
  class RacingAdapter extends JsonFileAdapter {
    override async update(collection: string, id: string, data: Record<string, unknown>) {
      if (collection === 'images' && !attached) {
        attached = true;
        const rows = JSON.parse(readFileSync(h.file, 'utf8'));
        rows.images[0].catalogPublishedReferenceLedger = h.ledger;
        rows.catalogDetailApprovals = [h.plan.proof];
        writeFileSync(h.file, JSON.stringify(rows));
      }
      return super.update(collection, id, data);
    }
  }
  const adapter = new RacingAdapter(h.file);
  setAdapter(adapter);
  const report = await backfillPublishedRefCounts();
  assert.equal(attached, true);
  assert.deepEqual(report.changes, []);
  assert.deepEqual(report.skipped, [{ imageId: 'image', reason: 'managed-references' }]);
  const read = await adapter.readCatalogImageReference({ imageId: 'image', action: 'read' });
  assert.ok(read.state === 'counted');
  assert.equal(read.effectiveCount, 1);
  assert.equal(read.image.publishedRefCount, 0);
  assert.deepEqual(read.image.catalogPublishedReferenceLedger, h.ledger);
});
test('backfill dry run reports managed rows without writing or claiming changes', async (t) => {
  const h = fixture(t);
  const before = h.bytes();
  const report = await backfillPublishedRefCounts({ dryRun: true });
  assert.deepEqual(report.changes, []);
  assert.deepEqual(report.skipped, [{ imageId: 'image', reason: 'managed-references' }]);
  assert.equal(h.bytes(), before);
});
test('backfill reports a concurrently missing image rather than claiming repair', async (t) => {
  const h = fixture(t, false);
  let removed = false;
  class RemovingAdapter extends JsonFileAdapter {
    override async update(collection: string, id: string, data: Record<string, unknown>) {
      if (collection === 'images' && !removed) {
        removed = true;
        await this.remove(collection, id);
      }
      return super.update(collection, id, data);
    }
  }
  setAdapter(new RemovingAdapter(h.file));
  const report = await backfillPublishedRefCounts();
  assert.deepEqual(report.changes, []);
  assert.deepEqual(report.skipped, [{ imageId: 'image', reason: 'missing' }]);
});
test('ordinary managed counter no-op preserves its pending references', async (t) => {
  const h = fixture(t);
  const result = await h.adapter.update('images', 'image', {
    publishedRefCount: 0,
    name: 'same-base',
  });
  assert.ok(result);
  assert.equal(result.publishedRefCount, 0);
  assert.deepEqual(result.catalogPublishedReferenceLedger, h.ledger);
});
test('ordinary legacy counter and new zero-count image remain supported', async (t) => {
  const h = fixture(t, false);
  assert.equal(
    (await h.adapter.update('images', 'image', { publishedRefCount: 1 }))?.publishedRefCount,
    1,
  );
  const created = await h.adapter.create('images', { name: 'new', publishedRefCount: 0 });
  assert.equal(created.publishedRefCount, 0);
  assert.equal(Object.hasOwn(created, 'catalogPublishedReferenceLedger'), false);
});
test('createOnly managed fields are checked only when actually creating', async (t) => {
  const h = fixture(t);
  const before = h.bytes();
  await assert.rejects(
    h.adapter.upsertDocWithId(
      'images',
      'missing',
      { name: 'new' },
      { catalogPublishedReferenceLedger: h.ledger },
    ),
  );
  assert.equal(h.bytes(), before);
  await assert.rejects(
    h.adapter.upsertDocWithId('images', 'missing', { name: 'new' }, { publishedRefCount: 'bad' }),
  );
  assert.equal(h.bytes(), before);
});
for (const method of ['update', 'upsert'] as const)
  test(`expired image ${method} lease does not write the target`, async (t) => {
    const h = fixture(t);
    const now = '2026-10-18T00:00:00.000Z';
    const grant = await h.adapter.acquireAlibabaSyncLease('c', 'holder', now, 60000);
    assert.ok(grant.result === 'granted');
    const guard = {
      connectionId: 'c',
      holder: 'holder',
      fence: grant.fence,
      now: '2026-10-18T00:02:00.000Z',
    };
    const before = h.bytes();
    const result =
      method === 'update'
        ? await h.adapter.updateDocWithAlibabaLease(
            'images',
            'image',
            { publishedRefCount: 1 },
            guard,
          )
        : await h.adapter.upsertDocWithAlibabaLease(
            'images',
            'image',
            { publishedRefCount: 1 },
            {},
            guard,
          );
    assert.equal(result, false);
    assert.equal(h.bytes(), before);
  });

for (const method of ['create', 'update', 'upsert', 'lease-update', 'lease-upsert'] as const)
  test(`ordinary image ${method} captures values before the JSON lock wait`, async (t) => {
    const h = fixture(t);
    const now = '2026-10-18T00:00:00.000Z';
    const grant = await h.adapter.acquireAlibabaSyncLease('c', 'holder', now, 60000);
    assert.ok(grant.result === 'granted');
    const guard = { connectionId: 'c', holder: 'holder', fence: grant.fence, now };
    const patch: Record<string, unknown> = { name: 'captured' };
    const createOnly: Record<string, unknown> = { publishedRefCount: 0 };
    const pending =
      method === 'create'
        ? h.adapter.create('images', patch)
        : method === 'update'
          ? h.adapter.update('images', 'image', patch)
          : method === 'upsert'
            ? h.adapter.upsertDocWithId('images', 'new-image', patch, createOnly)
            : method === 'lease-update'
              ? h.adapter.updateDocWithAlibabaLease('images', 'image', patch, guard)
              : h.adapter.upsertDocWithAlibabaLease(
                  'images',
                  'new-image',
                  patch,
                  createOnly,
                  guard,
                );
    patch.name = 'changed';
    patch.publishedRefCount = 99;
    patch.catalogPublishedReferenceLedger = {};
    createOnly.catalogPublishedReferenceLedger = {};
    const result = await pending;
    const image =
      typeof result === 'object' && result
        ? result
        : await h.adapter.get('images', method === 'lease-upsert' ? 'new-image' : 'image');
    assert.ok(image);
    assert.equal(image.name, 'captured');
    assert.notEqual(image.publishedRefCount, 99);
    if (method === 'update' || method === 'lease-update')
      assert.deepEqual(image.catalogPublishedReferenceLedger, h.ledger);
    else assert.equal(Object.hasOwn(image, 'catalogPublishedReferenceLedger'), false);
  });
test('lease-protected image metadata keeps its requested document identity', async (t) => {
  const h = fixture(t);
  const now = '2026-10-18T00:00:00.000Z';
  const grant = await h.adapter.acquireAlibabaSyncLease('c', 'holder', now, 60000);
  assert.ok(grant.result === 'granted');
  assert.equal(
    await h.adapter.updateDocWithAlibabaLease(
      'images',
      'image',
      { _id: 'other', name: 'new' },
      { connectionId: 'c', holder: 'holder', fence: grant.fence, now },
    ),
    true,
  );
  const image = await h.adapter.get('images', 'image');
  assert.ok(image);
  assert.equal(image.name, 'new');
  assert.deepEqual(image.catalogPublishedReferenceLedger, h.ledger);
  assert.equal(await h.adapter.get('images', 'other'), null);
});
for (const defaults of [{ catalogPublishedReferenceLedger: {} }, { publishedRefCount: 'bad' }])
  test(`deterministic image creation refuses reserved state ${Object.keys(defaults)[0]}`, async (t) => {
    const h = fixture(t);
    const before = h.bytes();
    await assert.rejects(h.adapter.createDocWithId('images', 'new-image', defaults));
    assert.equal(h.bytes(), before);
  });
test('deterministic image creation ignores unapplied values and captures new values before its lock', async (t) => {
  const h = fixture(t);
  const before = h.bytes();
  assert.equal(
    await h.adapter.createDocWithId('images', 'image', { catalogPublishedReferenceLedger: {} }),
    'exists',
  );
  assert.equal(h.bytes(), before);
  const input: Record<string, unknown> = { name: 'captured', publishedRefCount: 0 };
  const pending = h.adapter.createDocWithId('images', 'new-image', input);
  input.catalogPublishedReferenceLedger = {};
  input.name = 'changed';
  assert.equal(await pending, 'created');
  const image = await h.adapter.get('images', 'new-image');
  assert.ok(image);
  assert.equal(image.name, 'captured');
  assert.equal(Object.hasOwn(image, 'catalogPublishedReferenceLedger'), false);
});
test('backfill propagates an unknown persistence error rather than reporting a managed skip', async (t) => {
  const h = fixture(t, false);
  class FailedAdapter extends JsonFileAdapter {
    override async update(): Promise<never> {
      throw new Error('vendor-write-failed');
    }
  }
  setAdapter(new FailedAdapter(h.file));
  const before = h.bytes();
  await assert.rejects(backfillPublishedRefCounts(), { message: 'vendor-write-failed' });
  assert.equal(h.bytes(), before);
});
