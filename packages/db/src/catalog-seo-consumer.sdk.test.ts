import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
import { type CatalogSeoDatabase, createCatalogSeoStore } from './catalog-seo-cloud.ts';
import { consumeCatalogSeoRequest } from './catalog-seo-consumer.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';

const config = { siteOrigin: 'https://shop.example', detailEnabled: true };
const now = '2026-10-29T13:00:00.000Z';
function database(value: unknown): asserts value is CatalogSeoDatabase {
  assert.ok(value && typeof value === 'object');
  assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
  assert.equal(typeof Reflect.get(value, 'collection'), 'function');
  const command = Reflect.get(value, 'command');
  assert.ok(command && typeof command === 'object');
  assert.equal(typeof Reflect.get(command, 'gt'), 'function');
  assert.equal(typeof Reflect.get(command, 'set'), 'function');
}

test('actual installed SDK reads all immutable variants across pages and commits one checked request with its task', async (t) => {
  const f = articleSdkFixture(t);
  const native: unknown = f.db;
  database(native);
  const request = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    now,
  );
  f.put('catalogSeoRequests', request._id, request);
  const header = {
    _id: 'p',
    schemaVersion: 'catalog-product-detail-v1',
    name: 'Headset',
    images: [],
    facts: [],
    offers: [],
  };
  f.put('products', 'p', {
    name: 'Headset',
    published: true,
    productFamily: 'misc',
    catalogDetailPublication: {
      state: 'approved',
      revision: 'r1',
      variantCount: 137,
      variantStorage: 'immutable-v1',
      header,
    },
  });
  for (let position = 0; position < 137; position++) {
    const id = `v${position}`;
    f.put('catalogDetailVariants', approvedVariantDocumentId('p', 'r1', id), {
      productId: 'p',
      variantId: id,
      catalogDetailRevision: 'r1',
      catalogDetailPosition: position,
      catalogDetailApproved: {
        id,
        options: [],
        images: [],
        offers: [],
        inventory: { state: 'unknown' },
      },
      privateSource: 'DO_NOT_CAPTURE',
    });
  }
  const store = createCatalogSeoStore(native);
  const result = await consumeCatalogSeoRequest(store, request, config, now);
  assert.equal(result.status, 'checked');
  assert.equal(f.rows.get(`catalogSeoRequests/${request._id}`)?.state, 'checked');
  assert.equal([...f.rows].filter(([key]) => key.startsWith('catalogSeoTasks/')).length, 1);
  const queries = f.calls.filter(
    (c) => c.api === 'database.getDocument' && c.params.collectionName === 'catalogDetailVariants',
  );
  assert.equal(queries.length, 2);
  assert.ok(
    queries.every(
      (c) =>
        typeof c.params.projection === 'string' &&
        !String(c.params.projection).includes('privateSource'),
    ),
  );
  const writes = f.calls.filter((c) => c.api === 'database.modifyDocument');
  assert.equal(new Set(writes.map((c) => c.params.transactionId)).size, 1);
});

test('a task write rejected by the real SDK aborts the complete consumer transaction', async (t) => {
  const f = articleSdkFixture(t);
  const native: unknown = f.db;
  database(native);
  const request = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    now,
  );
  f.put('catalogSeoRequests', request._id, request);
  f.put('products', 'p', { name: 'Headset', published: true, productFamily: 'misc' });
  f.control.zeroWriteCollection = 'catalogSeoTasks';
  await assert.rejects(
    consumeCatalogSeoRequest(createCatalogSeoStore(native), request, config, now),
    /not acknowledged/,
  );
  assert.deepEqual(f.rows.get(`catalogSeoRequests/${request._id}`), request);
  assert.equal(
    [...f.rows].some(([key]) => key.startsWith('catalogPublicHeads/')),
    false,
  );
  assert.equal(f.calls.at(-1)?.api, 'database.abortTransaction');
});
