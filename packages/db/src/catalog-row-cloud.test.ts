import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import type { CatalogRowMutation } from './catalog-row-mutation.ts';
import * as cloud from './cloudbase-adapter.ts';

const now = '2026-10-13T00:00:00.000Z';
function fixture() {
  let store = new Map<string, CollectionDoc>([
    [
      'products/p',
      {
        _id: 'p',
        name: 'Before',
        productFamily: 'misc',
        published: false,
        catalogContentGeneration: 4,
        detailSourceReady: true,
      },
    ],
    [
      'products/q',
      {
        _id: 'q',
        name: 'Other',
        productFamily: 'misc',
        published: false,
        catalogContentGeneration: 9,
        detailSourceReady: true,
      },
    ],
    ['productVariants/v', { _id: 'v', productId: 'p', sku: 'Before', inventoryQuantity: 2 }],
    [
      'alibabaSyncLeases/primary',
      {
        _id: 'primary',
        holder: 'owner',
        fence: 2,
        heartbeatAt: now,
        expiresAt: '2026-10-13T00:03:00.000Z',
        releasedAt: '',
      },
    ],
  ]);
  const control = {
    fail: '',
    silent: '',
    coded: '',
    wrongId: '',
    arrayReads: false,
    maximumOperations: 0,
  };
  const collection = (name: string, copy: typeof store) => ({
    doc: (id: string) => {
      const key = `${name}/${id}`;
      return {
        get: async () => {
          const row = structuredClone(copy.get(key) ?? null);
          return { data: control.arrayReads ? (row ? [row] : []) : row };
        },
        update: async (_patch: Record<string, unknown>) => {
          throw new Error('catalog inputs use full-replace set');
        },
        set: async (data: Record<string, unknown>) => {
          assert.equal(Object.hasOwn(data, '_id'), false, 'SDK set payload excludes identity');
          if (control.fail === key) throw new Error('synthetic-write-fault');
          if (control.coded === key) return { code: 'DATABASE_TRANSACTION_CONFLICT' };
          if (control.silent === key) return { updated: 0 };
          const existed = copy.has(key);
          copy.set(key, { ...structuredClone(data), _id: id });
          return control.wrongId === key
            ? { upserted: [{ _id: 'wrong-id' }] }
            : existed
              ? { updated: 1 }
              : { upserted: [{ _id: id }] };
        },
        remove: async () => {
          if (control.fail === key) throw new Error('synthetic-write-fault');
          if (control.silent === key) return { deleted: 0 };
          return { deleted: copy.delete(key) ? 1 : 0 };
        },
      };
    },
  });
  const db = {
    command: { set: (value: unknown) => value },
    runTransaction: async <T>(
      operation: (tx: {
        collection: (name: string) => ReturnType<typeof collection>;
      }) => Promise<T>,
    ): Promise<T> => {
      const copy = structuredClone(store);
      let writes = false;
      let operations = 0;
      const tracked = (name: string) => ({
        doc: (id: string) => {
          const ref = collection(name, copy).doc(id);
          return {
            get: async () => {
              assert.equal(writes, false, 'read before write');
              operations++;
              return ref.get();
            },
            update: async (patch: Record<string, unknown>) => {
              writes = true;
              operations++;
              return ref.update(patch);
            },
            set: async (data: Record<string, unknown>) => {
              writes = true;
              operations++;
              return ref.set(data);
            },
            remove: async () => {
              writes = true;
              operations++;
              return ref.remove();
            },
          };
        },
      });
      try {
        const result = await operation({ collection: tracked });
        store = copy;
        return result;
      } finally {
        control.maximumOperations = Math.max(control.maximumOperations, operations);
      }
    },
  };
  return {
    db,
    control,
    get: (collection: string, id: string) =>
      structuredClone(store.get(`${collection}/${id}`) ?? null),
    snapshot: () => structuredClone(store),
  };
}
const updateVariant: CatalogRowMutation = {
  action: 'update',
  collection: 'productVariants',
  id: 'v',
  data: { sku: 'After' },
};

for (const action of ['update', 'upsert'] as const)
  test(`Cloud production fenced ${action} invalidates the variant parent in the same transaction`, async () => {
    const h = fixture();
    const guard = { connectionId: 'primary', holder: 'owner', fence: 2, now };
    const result =
      action === 'update'
        ? await cloud.updateDocWithAlibabaLeaseInCloudBase(
            h.db,
            'productVariants',
            'v',
            { sku: 'After' },
            guard,
          )
        : await cloud.upsertDocWithAlibabaLeaseInCloudBase(
            h.db,
            'productVariants',
            'v',
            { sku: 'After' },
            {},
            guard,
          );
    assert.equal(result, true);
    assert.equal(h.get('products', 'p')?.catalogContentGeneration, 5);
    assert.equal(h.get('products', 'p')?.detailSourceReady, false);
  });

for (const action of ['create', 'create-if-missing', 'upsert'] as const)
  test(`Cloud ${action} creates an unprepared product with zero versions`, async () => {
    const h = fixture();
    const result = await cloud.mutateCatalogRowInCloudBase(
      h.db,
      { action, collection: 'products', id: 'new', data: { name: 'New', detailSourceReady: true } },
      now,
    );
    assert.equal(result.status, 'written');
    assert.equal(h.get('products', 'new')?.catalogContentGeneration, 0);
    assert.equal(h.get('products', 'new')?.detailSourceReady, false);
  });

for (const action of ['update', 'upsert', 'remove', 'increment'] as const)
  test(`Cloud variant ${action} invalidates its parent atomically`, async () => {
    const h = fixture();
    const command: CatalogRowMutation =
      action === 'remove'
        ? { action, collection: 'productVariants', id: 'v' }
        : action === 'increment'
          ? { action, collection: 'productVariants', id: 'v', field: 'inventoryQuantity', delta: 1 }
          : { ...updateVariant, action };
    await cloud.mutateCatalogRowInCloudBase(h.db, command, now);
    assert.equal(h.get('products', 'p')?.catalogContentGeneration, 5);
    assert.equal(h.get('products', 'p')?.detailSourceReady, false);
  });

test('Cloud variant move invalidates both parents and stays within six doc operations', async () => {
  const h = fixture();
  await cloud.mutateCatalogRowInCloudBase(
    h.db,
    { ...updateVariant, data: { productId: 'q' } },
    now,
  );
  assert.equal(h.get('products', 'p')?.catalogContentGeneration, 5);
  assert.equal(h.get('products', 'q')?.catalogContentGeneration, 10);
  assert.equal(h.control.maximumOperations, 6);
});

test('Cloud no-op variant, conditional miss and unrelated product counter retain readiness', async () => {
  const h = fixture();
  await cloud.mutateCatalogRowInCloudBase(h.db, { ...updateVariant, data: { sku: 'Before' } }, now);
  const removed = await cloud.mutateCatalogRowInCloudBase(
    h.db,
    {
      action: 'remove',
      collection: 'productVariants',
      id: 'v',
      expectedField: { field: 'productId', value: 'q' },
    },
    now,
  );
  assert.equal(removed.status, 'missing');
  await cloud.mutateCatalogRowInCloudBase(
    h.db,
    { action: 'increment', collection: 'products', id: 'p', field: 'views', delta: 1 },
    now,
  );
  assert.equal(h.get('products', 'p')?.catalogContentGeneration, 4);
  assert.equal(h.get('products', 'p')?.detailSourceReady, true);
});

for (const control of ['fail', 'silent', 'coded', 'wrongId'] as const)
  test(`Cloud ${control} write refuses success and rolls back the child plus parent`, async () => {
    const h = fixture();
    h.control[control] = 'products/p';
    const before = h.snapshot();
    await assert.rejects(cloud.mutateCatalogRowInCloudBase(h.db, updateVariant, now));
    assert.deepEqual(h.snapshot(), before);
  });

test('Cloud silent deletion cannot invalidate the parent without deleting the child', async () => {
  const h = fixture();
  h.control.silent = 'productVariants/v';
  const before = h.snapshot();
  await assert.rejects(
    cloud.mutateCatalogRowInCloudBase(
      h.db,
      { action: 'remove', collection: 'productVariants', id: 'v' },
      now,
    ),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('Cloud array-shaped reads preserve exact nested replacements and authoritative private versions', async () => {
  const h = fixture();
  h.control.arrayReads = true;
  await cloud.mutateCatalogRowInCloudBase(
    h.db,
    {
      action: 'update',
      collection: 'products',
      id: 'p',
      data: { name: 'After', catalogContentGeneration: 0, manualCatalogPricing: { mode: 'fixed' } },
    },
    now,
  );
  assert.equal(h.get('products', 'p')?.catalogContentGeneration, 5);
  assert.deepEqual(h.get('products', 'p')?.manualCatalogPricing, { mode: 'fixed' });
});

for (const action of ['create', 'create-if-missing', 'upsert'] as const)
  test(`Cloud variant ${action} writes its new row and invalidates an existing parent`, async () => {
    const h = fixture();
    await cloud.mutateCatalogRowInCloudBase(
      h.db,
      { action, collection: 'productVariants', id: 'new-v', data: { productId: 'p', sku: 'New' } },
      now,
    );
    assert.equal(h.get('productVariants', 'new-v')?.sku, 'New');
    assert.equal(h.get('products', 'p')?.catalogContentGeneration, 5);
  });

test('Cloud fenced catalog writer refuses a stale holder without touching either row', async () => {
  const h = fixture();
  const before = h.snapshot();
  assert.equal(
    await cloud.updateDocWithAlibabaLeaseInCloudBase(
      h.db,
      'productVariants',
      'v',
      { sku: 'After' },
      { connectionId: 'primary', holder: 'old-owner', fence: 1, now },
    ),
    false,
  );
  assert.deepEqual(h.snapshot(), before);
});

for (const field of [
  'catalogContentGeneration',
  'catalogLifecycleVersion',
  'catalogClassificationRevision',
])
  test(`Cloud ordinary increment cannot mutate private ${field}`, async () => {
    const h = fixture();
    const before = h.snapshot();
    await assert.rejects(
      cloud.mutateCatalogRowInCloudBase(
        h.db,
        { action: 'increment', collection: 'products', id: 'p', field, delta: 1 },
        now,
      ),
    );
    assert.deepEqual(h.snapshot(), before);
  });

for (const identity of [null, 17, ['bad-id']])
  test('Cloud create refuses a supplied non-string identity before SDK access', async () => {
    await assert.rejects(
      cloud.cloudBaseAdapter.create('products', { _id: identity, name: 'Invalid identity' }),
      /Catalog row identity must be a string/,
    );
  });
