import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { SourcePageSchema, sourceDigest, stageSourcePage } from './catalog-source-staging.ts';

test('source preparation seals only the complete generation; retries, changed observation and wrong actor are safe', async () => {
  const store: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/product': {
      _id: 'product',
      alibabaPrimarySourceKey: 'source',
      imageIds: [],
      published: true,
      name: 'Manual title',
      unitPrice: 7,
    },
    'catalogSourceObservations/source': { _id: 'source', observation: { value: 1 } },
  };
  const tx = {
    get: async (c: string, id: string) => structuredClone(store[`${c}/${id}`] ?? null),
    set: async (c: string, row: CollectionDoc) => {
      store[`${c}/${row._id}`] = structuredClone(row);
    },
  };
  const ids = Array.from({ length: 21 }, (_, i) => `sku-${i}`);
  const page = (index: number) =>
    SourcePageSchema.parse({
      action: 'source-page',
      productId: 'product',
      sourceKey: 'source',
      observationId: 'source',
      observationDigest: sourceDigest({ value: 1 }),
      galleryDigest: sourceDigest([]),
      revision: 'a'.repeat(64),
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'product',
        name: 'Source',
        images: [],
        facts: [],
        offers: [],
      },
      content: null,
      noteBlocks: null,
      variantIds: ids,
      page: index,
      variants: ids.slice(index * 20, (index + 1) * 20).map((id) => ({
        id,
        options: [],
        images: [],
        offers: [],
        inventory: { state: 'unknown' },
      })),
    });
  assert.deepEqual(await stageSourcePage(tx, 'stranger', page(0)), {
    ok: false,
    code: 'FORBIDDEN',
  });
  assert.deepEqual(await stageSourcePage(tx, 'admin', page(1)), {
    ok: false,
    code: 'SOURCE_NOT_READY',
  });
  assert.equal((await stageSourcePage(tx, 'admin', page(0))).ok, true);
  assert.equal(store['products/product']?.detailSourceReady, false);
  assert.equal((await stageSourcePage(tx, 'admin', page(0))).ok, true);
  store['catalogSourceObservations/source'] = { _id: 'source', observation: { value: 2 } };
  assert.deepEqual(await stageSourcePage(tx, 'admin', page(1)), { ok: false, code: 'CONFLICT' });
  store['catalogSourceObservations/source'] = { _id: 'source', observation: { value: 1 } };
  const done = await stageSourcePage(tx, 'admin', page(1));
  assert.equal(done.ok && done.complete, true);
  const product = store['products/product'];
  assert.equal(product?.detailSourceReady, true);
  assert.equal(product?.name, 'Manual title');
  assert.equal(product?.unitPrice, 7);
  assert.equal(product?.published, true);
  assert.equal(Object.keys(store).filter((key) => key.startsWith('productVariants/')).length, 21);
});
