import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { previewCategory } from './category-transaction.ts';
import { type NodeSdkDatabase, manageCatalogCategoryInCloud } from './cloudbase-adapter.ts';

test('cloud transaction adapter accepts SDK insert acknowledgement and rolls back an unacknowledged write', async () => {
  let store: Record<string, Record<string, CollectionDoc>> = {
    users: { admin: { _id: 'admin', role: 'admin' } },
    products: {
      clock: {
        _id: 'clock',
        name: 'Clock',
        published: false,
        alibabaPrimarySourceKey: 's',
        alibabaSourceCategoryId: '152801',
      },
    },
    sourceCategoryMappings: {},
    alibabaSourceProducts: { s: { _id: 's', active: true, sourceCategoryId: '152801' } },
    alibabaProductLinks: { s: { _id: 's', productId: 'clock' } },
  };
  let fail = false;
  const db: Pick<NodeSdkDatabase, 'runTransaction'> = {
    runTransaction: async (operation) => {
      const draft = structuredClone(store);
      const result = await operation({
        collection: (collection) => ({
          doc: (id) => ({
            get: async () => ({ data: draft[collection]?.[id] ? [draft[collection]?.[id]] : [] }),
            update: async () => {
              throw new Error('Unexpected partial write');
            },
            remove: async () => {
              throw new Error('Unexpected delete');
            },
            set: async (data) => {
              assert.equal(Object.hasOwn(data, '_id'), false);
              if (fail && collection === 'products') return {};
              const existed = Boolean(draft[collection]?.[id]);
              draft[collection] ??= {};
              draft[collection][id] = { ...data, _id: id };
              return existed ? { updated: 1 } : { updated: 0, upserted: [{ _id: id }] };
            },
          }),
        }),
      });
      store = draft;
      return result;
    },
  };
  const now = new Date().toISOString();
  assert.equal(
    (
      await manageCatalogCategoryInCloud(
        db,
        'admin',
        { kind: 'configure', sourceCategoryId: '152801' },
        now,
      )
    ).status,
    'configured',
  );
  const product = store.products?.clock;
  assert.ok(product);
  const preview = previewCategory(
    product,
    store.sourceCategoryMappings?.['alibaba-icbu-152801'],
    now,
  );
  assert.equal(preview.status, 'ready');
  const command = { ...preview.command, operationId: randomUUID() };
  const before = structuredClone(store);
  fail = true;
  await assert.rejects(
    () => manageCatalogCategoryInCloud(db, 'admin', command, now),
    /not acknowledged/,
  );
  assert.deepEqual(store, before);
  fail = false;
  assert.equal((await manageCatalogCategoryInCloud(db, 'admin', command, now)).status, 'applied');
  assert.equal((await manageCatalogCategoryInCloud(db, 'admin', command, now)).status, 'replayed');
});
