import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import { batchRemove, batchUpdate, setAdapter } from '@vibelingan-channel/db';
import {
  CatalogPreparationCommitSchema,
  catalogPreparationInputDigest,
  readCatalogPreparationInputs,
} from '@vibelingan-channel/db/catalog-preparation-store';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { JsonFileAdapter } from './json-adapter.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-row-invalidation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const product = (id: string) => ({
    _id: id,
    name: `Clock ${id}`,
    productFamily: 'misc',
    published: false,
    archived: false,
    detailSourceReady: true,
    catalogPreparationState: 'ready',
    catalogContentGeneration: 4,
    catalogLifecycleVersion: 2,
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...(id === 'p' ? { alibabaPrimarySourceKey: 'k' } : {}),
  });
  writeFileSync(
    file,
    JSON.stringify({
      products: [product('p'), product('q')],
      productVariants: [
        { _id: 'v', productId: 'p', sku: 'Before', inventoryQuantity: 2, archived: false },
      ],
      alibabaProductLinks: [{ _id: 'k', sourceKey: 'k', productId: 'p' }],
      alibabaSourceProducts: [
        {
          _id: 'k',
          sourceKey: 'k',
          connectionId: 'test',
          sourceProductId: 'external',
          active: true,
          sourceTitle: 'Before',
          sourceCategoryId: 1,
          contentHash: 'a'.repeat(64),
          payloadId: 'raw-old',
          catalogBindingGeneration: 3,
        },
      ],
      catalogSourceObservations: [
        {
          _id: 'obs',
          provider: 'alibaba',
          sourceProductKey: 'k',
          active: true,
          observation: {
            source: { provider: 'alibaba', sourceProductKey: 'k' },
            identity: { title: 'Before' },
          },
        },
      ],
    }),
  );
  return { db: new JsonFileAdapter(file), file };
}
async function stale(db: JsonFileAdapter, id = 'p') {
  const product = await db.get('products', id);
  assert.ok(product);
  assert.equal(product.catalogContentGeneration, 5);
  assert.equal(product.detailSourceReady, false);
  assert.equal(product.catalogPreparationState, 'stale');
  assert.equal(product.published, false);
  assert.equal(product.catalogLifecycleVersion, 2);
}

for (const kind of ['update', 'upsert'] as const) {
  test(`generic product ${kind} invalidates the same row atomically`, async (t) => {
    const { db } = fixture(t);
    if (kind === 'update') await db.update('products', 'p', { name: 'After' });
    else await db.upsertDocWithId('products', 'p', { name: 'After' });
    await stale(db);
  });
}
for (const kind of ['create', 'create-id', 'upsert-new'] as const) {
  test(`generic product ${kind} starts unprepared with legacy-compatible zero versions`, async (t) => {
    const { db } = fixture(t);
    const values = {
      name: 'New draft',
      published: false,
      detailSourceReady: true,
      catalogPreparationState: 'ready',
    };
    let id = 'new';
    if (kind === 'create') id = (await db.create('products', values))._id;
    else if (kind === 'create-id')
      assert.equal(await db.createDocWithId('products', id, values), 'created');
    else await db.upsertDocWithId('products', id, values);
    const product = await db.get('products', id);
    assert.ok(product);
    assert.equal(product.catalogContentGeneration, 0);
    assert.equal(product.catalogLifecycleVersion, 0);
    assert.equal(product.detailSourceReady, false);
  });
}
for (const kind of [
  'create',
  'create-id',
  'upsert',
  'update',
  'remove',
  'conditional-remove',
  'increment',
] as const) {
  test(`generic variant ${kind} invalidates its parent in the same commit`, async (t) => {
    const { db } = fixture(t);
    if (kind === 'create') await db.create('productVariants', { productId: 'p', sku: 'New' });
    if (kind === 'create-id')
      await db.createDocWithId('productVariants', 'v2', { productId: 'p', sku: 'New' });
    if (kind === 'upsert') await db.upsertDocWithId('productVariants', 'v', { sku: 'After' });
    if (kind === 'update') await db.update('productVariants', 'v', { sku: 'After' });
    if (kind === 'remove') assert.equal(await db.remove('productVariants', 'v'), true);
    if (kind === 'conditional-remove')
      assert.equal(await db.removeDocIfFieldEquals('productVariants', 'v', 'productId', 'p'), true);
    if (kind === 'increment')
      assert.equal(await db.incrementField('productVariants', 'v', 'inventoryQuantity', 1), 3);
    await stale(db);
  });
}
test('moving a configuration invalidates both existing parents', async (t) => {
  const { db } = fixture(t);
  await db.update('productVariants', 'v', { productId: 'q' });
  await stale(db, 'p');
  await stale(db, 'q');
});
test('identical row capture and non-content product counters preserve preparation', async (t) => {
  const { db } = fixture(t);
  await db.update('productVariants', 'v', { sku: 'Before' });
  await db.incrementField('products', 'p', 'views', 1);
  const product = await db.get('products', 'p');
  assert.ok(product);
  assert.equal(product.catalogContentGeneration, 4);
  assert.equal(product.detailSourceReady, true);
});
test('a conditional delete that did not match changes neither child nor parent', async (t) => {
  const { db } = fixture(t);
  assert.equal(
    await db.removeDocIfFieldEquals('productVariants', 'v', 'productId', 'other'),
    false,
  );
  assert.ok(await db.get('productVariants', 'v'));
  assert.equal((await db.get('products', 'p'))?.detailSourceReady, true);
});
for (const kind of ['update', 'upsert'] as const) {
  test(`fenced variant ${kind} also invalidates its parent`, async (t) => {
    const { db } = fixture(t);
    const now = new Date().toISOString();
    const lease = await db.acquireAlibabaSyncLease('primary', 'owner', now, 30000);
    assert.equal(lease.result, 'granted');
    if (lease.result !== 'granted') throw new Error('Lease fixture failed');
    const guard = { connectionId: 'primary', holder: 'owner', fence: lease.fence, now };
    const saved =
      kind === 'update'
        ? await db.updateDocWithAlibabaLease('productVariants', 'v', { sku: 'After' }, guard)
        : await db.upsertDocWithAlibabaLease('productVariants', 'v', { sku: 'After' }, {}, guard);
    assert.equal(saved, true);
    await stale(db);
  });
}
for (const kind of ['product', 'source'] as const) {
  test(`an uncommitted ${kind} persistence failure is not visible on the next normal read`, async (t) => {
    const { db, file } = fixture(t);
    const before = readFileSync(file, 'utf8');
    const persist: unknown = Reflect.get(db, 'persist');
    assert.equal(typeof persist, 'function');
    Reflect.set(db, 'persist', () => {
      throw new Error('synthetic-disk-fault');
    });
    try {
      await assert.rejects(
        kind === 'product'
          ? db.update('products', 'p', { name: 'Not committed' })
          : db.upsertCatalogSourceObservation(
              'obs',
              { active: false, observedAt: new Date().toISOString() },
              {},
            ),
        /synthetic-disk-fault/,
      );
    } finally {
      Reflect.set(db, 'persist', persist);
    }
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal((await db.get('products', 'p'))?.name, 'Clock p');
    assert.equal((await db.get('products', 'p'))?.detailSourceReady, true);
  });
}

test('facade batch product edits invalidate each actual updated product', async (t) => {
  const { db } = fixture(t);
  setAdapter(db);
  const updated = await batchUpdate('products', ['p', 'q'], { name: 'Batch changed' });
  assert.equal(updated.length, 2);
  assert.equal((await db.get('products', 'p'))?.catalogContentGeneration, 5);
  assert.equal((await db.get('products', 'q'))?.catalogContentGeneration, 5);
  assert.equal((await db.get('products', 'p'))?.detailSourceReady, false);
});

test('facade batch child deletion invalidates once and reports only the removed ID', async (t) => {
  const { db } = fixture(t);
  setAdapter(db);
  assert.deepEqual(await batchRemove('productVariants', ['v', 'v']), ['v']);
  await stale(db);
});

test('two actual JSON adapters serialize source and child changes without losing either invalidation', async (t) => {
  const { db, file } = fixture(t);
  const other = new JsonFileAdapter(file);
  await Promise.all([
    db.update('productVariants', 'v', { sku: 'Concurrent child' }),
    other.upsertCatalogSourceObservation(
      'obs',
      { active: false, observedAt: new Date().toISOString() },
      {},
    ),
  ]);
  const parent = await db.get('products', 'p');
  assert.equal(parent?.catalogContentGeneration, 6);
  assert.equal(parent?.detailSourceReady, false);
  assert.equal((await db.get('productVariants', 'v'))?.sku, 'Concurrent child');
  assert.equal((await db.get('catalogSourceObservations', 'obs'))?.active, false);
});

for (const identity of [null, 17, ['bad-id']])
  test('JSON create refuses a supplied non-string identity without changing storage', async (t) => {
    const { db, file } = fixture(t);
    const before = readFileSync(file, 'utf8');
    await assert.rejects(
      db.create('products', { _id: identity, name: 'Invalid identity' }),
      /Catalog row identity must be a string/,
    );
    assert.equal(readFileSync(file, 'utf8'), before);
  });

test('two JSON adapters creating the same variant invalidate its parent exactly once', async (t) => {
  const { db, file } = fixture(t);
  const other = new JsonFileAdapter(file);
  const results = await Promise.allSettled([
    db.createDocWithId('productVariants', 'new-v', { productId: 'p', sku: 'New' }),
    other.createDocWithId('productVariants', 'new-v', { productId: 'p', sku: 'New' }),
  ]);
  const statuses = results.map((result) => {
    if (result.status !== 'fulfilled') throw result.reason;
    return result.value;
  });
  assert.deepEqual(statuses.sort(), ['created', 'exists']);
  await stale(db);
  assert.ok(await db.get('productVariants', 'new-v'));
});

test('two JSON adapters deleting the same variant invalidate its parent exactly once', async (t) => {
  const { db, file } = fixture(t);
  const other = new JsonFileAdapter(file);
  const results = await Promise.allSettled([
    db.remove('productVariants', 'v'),
    other.remove('productVariants', 'v'),
  ]);
  const removed = results.map((result) => {
    if (result.status !== 'fulfilled') throw result.reason;
    return result.value;
  });
  assert.deepEqual(removed.sort(), [false, true]);
  await stale(db);
  assert.equal(await db.get('productVariants', 'v'), null);
});

for (const kind of [
  'create',
  'create-id',
  'upsert',
  'update',
  'remove',
  'conditional-remove',
  'increment',
  'lease-upsert',
  'lease-update',
] as const)
  test(`normalized source ${kind} invalidates its primary product in the same JSON commit`, async (t) => {
    const { db, file } = fixture(t);
    const source = await db.get('alibabaSourceProducts', 'k');
    assert.ok(source);
    if (kind === 'create' || kind === 'create-id') {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      stored.alibabaSourceProducts = [];
      writeFileSync(file, JSON.stringify(stored));
    }
    if (kind === 'create')
      await db.create('alibabaSourceProducts', { ...source, sourceTitle: 'After' });
    if (kind === 'create-id')
      assert.equal(
        await db.createDocWithId('alibabaSourceProducts', 'k', { ...source, sourceTitle: 'After' }),
        'created',
      );
    if (kind === 'upsert')
      await db.upsertDocWithId('alibabaSourceProducts', 'k', { sourceTitle: 'After' });
    if (kind === 'update') await db.update('alibabaSourceProducts', 'k', { active: false });
    if (kind === 'remove') assert.equal(await db.remove('alibabaSourceProducts', 'k'), true);
    if (kind === 'conditional-remove')
      assert.equal(
        await db.removeDocIfFieldEquals('alibabaSourceProducts', 'k', 'active', true),
        true,
      );
    if (kind === 'increment')
      assert.equal(await db.incrementField('alibabaSourceProducts', 'k', 'sourceCategoryId', 1), 2);
    if (kind.startsWith('lease-')) {
      const now = new Date().toISOString();
      const lease = await db.acquireAlibabaSyncLease('test', 'worker', now, 60000);
      assert.equal(lease.result, 'granted');
      assert.ok(lease.result === 'granted');
      const guard = { connectionId: 'test', holder: 'worker', fence: lease.fence, now };
      if (kind === 'lease-update')
        assert.equal(
          await db.updateDocWithAlibabaLease(
            'alibabaSourceProducts',
            'k',
            { active: false },
            guard,
          ),
          true,
        );
      else
        assert.equal(
          await db.upsertDocWithAlibabaLease(
            'alibabaSourceProducts',
            'k',
            { sourceTitle: 'After' },
            {},
            guard,
          ),
          true,
        );
    }
    await stale(db);
  });

test('normalized source metadata recapture preserves ready and its private binding fence', async (t) => {
  const { db } = fixture(t);
  await db.update('alibabaSourceProducts', 'k', {
    payloadId: 'raw-new',
    lastSeenRunId: 'new-run',
    fetchedAt: '2026-10-14T00:00:00.000Z',
    catalogBindingGeneration: 999,
  });
  const product = await db.get('products', 'p');
  assert.equal(product?.detailSourceReady, true);
  assert.equal(product?.catalogContentGeneration, 4);
  assert.equal((await db.get('alibabaSourceProducts', 'k'))?.catalogBindingGeneration, 3);
  await assert.rejects(
    db.incrementField('alibabaSourceProducts', 'k', 'catalogBindingGeneration', 1),
  );
});

for (const kind of [
  'create',
  'create-id',
  'upsert',
  'update',
  'remove',
  'conditional-remove',
] as const)
  test(`generic observation ${kind} invalidates its primary product in the same JSON commit`, async (t) => {
    const { db, file } = fixture(t);
    const source = await db.get('catalogSourceObservations', 'obs');
    assert.ok(source);
    if (kind === 'create' || kind === 'create-id') {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      stored.catalogSourceObservations = [];
      writeFileSync(file, JSON.stringify(stored));
    }
    if (kind === 'create')
      await db.create('catalogSourceObservations', { ...source, active: false });
    if (kind === 'create-id')
      assert.equal(
        await db.createDocWithId('catalogSourceObservations', 'obs', { ...source, active: false }),
        'created',
      );
    if (kind === 'upsert')
      await db.upsertDocWithId('catalogSourceObservations', 'obs', { active: false });
    if (kind === 'update') await db.update('catalogSourceObservations', 'obs', { active: false });
    if (kind === 'remove') assert.equal(await db.remove('catalogSourceObservations', 'obs'), true);
    if (kind === 'conditional-remove')
      assert.equal(
        await db.removeDocIfFieldEquals('catalogSourceObservations', 'obs', 'active', true),
        true,
      );
    await stale(db);
  });

for (const action of ['update', 'upsert', 'create'] as const) {
  test(`JSON ${action} cannot install a forged ready report`, async (t) => {
    const { db } = fixture(t);
    const values = {
      catalogPreparationState: 'ready',
      catalogPreparationPolicy: 'forged',
      catalogPreparationReport: { state: 'ready' },
    };
    const id = action === 'create' ? 'new-report' : 'p';
    if (action === 'create') await db.createDocWithId('products', id, { name: 'New', ...values });
    else if (action === 'upsert') await db.upsertDocWithId('products', id, values);
    else await db.update('products', id, values);
    const saved = await db.get('products', id);
    assert.ok(saved);
    assert.equal(saved.catalogPreparationState, action === 'create' ? 'stale' : 'ready');
    assert.equal(Object.hasOwn(saved, 'catalogPreparationPolicy'), false);
    assert.equal(Object.hasOwn(saved, 'catalogPreparationReport'), false);
    assert.equal(saved.published, action === 'create' ? undefined : false);
  });
}

test('JSON legacy raw capture loses and recovers its pairing with atomic version invalidation', async (t) => {
  const { db, file } = fixture(t);
  const data: Record<string, CollectionDoc[]> = JSON.parse(readFileSync(file, 'utf8'));
  data.catalogSourceObservations = [
    {
      _id: sourceObservationDocumentId('alibaba', 'k'),
      provider: 'alibaba',
      sourceProductKey: 'k',
      evidenceId: 'raw-old',
      observation: {
        source: { provider: 'alibaba', sourceProductKey: 'k' },
        identity: { title: 'Before' },
      },
    },
  ];
  writeFileSync(file, JSON.stringify(data));
  await db.update('alibabaSourceProducts', 'k', { payloadId: 'raw-new' });
  await stale(db);
  await db.update('catalogSourceObservations', sourceObservationDocumentId('alibaba', 'k'), {
    evidenceId: 'raw-new',
  });
  assert.equal((await db.get('products', 'p'))?.catalogContentGeneration, 6);
  assert.equal((await db.get('products', 'p'))?.catalogPreparationState, 'stale');
});
async function localPreparationCommand(db: JsonFileAdapter) {
  const product = await db.get('products', 'q');
  assert.ok(product);
  const input = await readCatalogPreparationInputs(db, product);
  return CatalogPreparationCommitSchema.parse({
    action: 'preparation-report',
    report: {
      schemaVersion: 'catalog-preparation-report-v1',
      productId: 'q',
      inputDigest: catalogPreparationInputDigest(input),
      policyVersion: CATALOG_PREPARATION_POLICY,
      contentGeneration: product.catalogContentGeneration,
      checkedAt: '2026-10-14T00:00:00.000Z',
      state: 'ready',
      previewReady: true,
      mediaReady: true,
      issues: [],
    },
  });
}
function preparationFixture(t: TestContext) {
  const h = fixture(t);
  const data: Record<string, CollectionDoc[]> = JSON.parse(readFileSync(h.file, 'utf8'));
  data.users = [{ _id: 'admin', role: 'admin' }];
  writeFileSync(h.file, JSON.stringify(data));
  return h;
}
test('JSON report replay preserves file bytes and does not call disk persistence again', async (t) => {
  const { db, file } = preparationFixture(t);
  const command = await localPreparationCommand(db);
  assert.ok((await db.persistCatalogDetailApproval('admin', command)).ok);
  const before = readFileSync(file, 'utf8');
  const persist: unknown = Reflect.get(db, 'persist');
  assert.equal(typeof persist, 'function');
  let writes = 0;
  Reflect.set(db, 'persist', () => {
    writes++;
    if (typeof persist === 'function') Reflect.apply(persist, db, []);
  });
  try {
    assert.deepEqual(await db.persistCatalogDetailApproval('admin', command), {
      ok: true,
      preparation: 'unchanged',
      productId: 'q',
    });
    assert.equal(writes, 0);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    Reflect.set(db, 'persist', persist);
  }
});
test('JSON report disk failure leaves both stored and next-read product state unchanged', async (t) => {
  const { db, file } = preparationFixture(t);
  const command = await localPreparationCommand(db);
  const before = readFileSync(file, 'utf8');
  const product = await db.get('products', 'q');
  const persist: unknown = Reflect.get(db, 'persist');
  Reflect.set(db, 'persist', () => {
    throw new Error('report-disk-fault');
  });
  try {
    await assert.rejects(db.persistCatalogDetailApproval('admin', command), /report-disk-fault/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(await db.get('products', 'q'), product);
  } finally {
    Reflect.set(db, 'persist', persist);
  }
});

for (const [field, value] of [
  ['alibabaPhotosPending', true],
  [
    'alibabaAutoPhotos',
    {
      configurations: {
        sources: ['https://sc04.alicdn.com/a.jpg'],
        imageIds: [],
        missing: [],
        unusable: [],
      },
    },
  ],
] as const) {
  test(`JSON photo preparation ${field} is an input even without gallery changes`, async (t) => {
    const { db } = fixture(t);
    const before = await db.get('products', 'p');
    assert.ok(before);
    await db.update('products', 'p', { [field]: value });
    await stale(db);
    const saved = await db.get('products', 'p');
    assert.ok(saved);
    assert.deepEqual(saved.imageIds, before.imageIds);
    assert.deepEqual(saved.descriptionImageIds, before.descriptionImageIds);
    await db.update('products', 'p', { [field]: structuredClone(value) });
    assert.equal((await db.get('products', 'p'))?.catalogContentGeneration, 5);
  });
}
