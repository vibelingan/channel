import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import type { ApiResult, CollectionDoc, ListResult } from '@vibelingan-channel/shared';
import { projectPublicProduct } from './catalog/project-public-product.ts';
import { getCatalogItem, getCatalogItemBySlug, listCatalog, publicDoc } from './handler.ts';

const config = { apiBaseUrl: 'https://catalog.example.test' };

function resultData<T>(result: ApiResult<unknown>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.data as T;
}

function readOnlyProductAdapter(product: CollectionDoc): DbAdapter {
  const unused = async (): Promise<never> => {
    throw new Error('unused write operation');
  };
  return {
    async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
      return {
        items: [product],
        total: 1,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
    async get(collection, id) {
      return collection === 'products' && id === product._id ? product : null;
    },
    async findByField(collection, field, value) {
      return collection === 'products' && product[field] === value ? product : null;
    },
    create: unused,
    update: unused,
    remove: unused,
    incrementField: unused,
  };
}

test('public products project valid manual tiers and Headphones subcategory', () => {
  const projected = publicDoc(
    'products',
    {
      _id: 'headphones-1',
      name: 'Studio Headphones',
      productFamily: 'headphones',
      category: 'studio',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [
          { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
          { minQuantity: 13, unitAmountMinor: 11_831 },
        ],
      },
    },
    config,
  );

  assert.ok(projected);
  assert.equal(projected.category, 'studio');
  assert.deepEqual(projected.manualCatalogPricing, {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'USD',
    tiers: [
      { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
      { minQuantity: 13, unitAmountMinor: 11_831 },
    ],
  });
});

test('public products omit malformed manual pricing and stale non-Headphones category', () => {
  const projected = publicDoc(
    'products',
    {
      _id: 'toy-1',
      name: 'Interactive Toy',
      productFamily: 'toys',
      category: 'office',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [{ minQuantity: 1, unitAmountMinor: -1 }],
      },
    },
    config,
  );

  assert.ok(projected);
  assert.equal(projected.name, 'Interactive Toy');
  assert.equal(Object.hasOwn(projected, 'category'), false);
  assert.equal(Object.hasOwn(projected, 'manualCatalogPricing'), false);
});

test('projects required product fields while omitting malformed optional fields', () => {
  const projected = projectPublicProduct({
    _id: 'toy-optional-corruption',
    name: 'Still Visible Toy',
    productFamily: 'toys',
    published: true,
    slug: ' / ',
    skuCode: '   ',
    images: [null],
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [{ minQuantity: 1, unitAmountMinor: -1 }],
    },
    alibabaCatalogPricing: {
      schemaVersion: 'alibaba-catalog-pricing-v1',
      source: 'alibaba',
      mode: 'fixed',
      amountMinor: -1,
      syncedAt: '2026-08-24T00:00:00.000Z',
    },
    vipPrice: 5,
    imageIds: ['private-image-id'],
  });

  assert.ok(projected);
  assert.equal(projected.name, 'Still Visible Toy');
  for (const field of [
    'slug',
    'skuCode',
    'images',
    'manualCatalogPricing',
    'alibabaCatalogPricing',
    'vipPrice',
    'imageIds',
  ]) {
    assert.equal(Object.hasOwn(projected, field), false, field);
  }
});

test('returns null for an explicit corrupt family', () => {
  assert.equal(
    projectPublicProduct({
      _id: 'bad-family',
      name: 'Bad Family',
      productFamily: 'gadgets',
    }),
    null,
  );
});

test('list, ID, and slug paths share one deeply equal product projection', async () => {
  const product: CollectionDoc = {
    _id: 'same-product',
    name: 'Same Product',
    productFamily: 'headphones',
    category: 'office',
    published: true,
    archived: false,
    slug: 'same-product',
    skuCode: ' SAME-SKU ',
    imageIds: ['image-1'],
    vipPrice: 7,
    internalOnly: 'never-public',
  };
  setAdapter(readOnlyProductAdapter(product));

  const [listResult, idResult, slugResult] = await Promise.all([
    listCatalog('products', {}, config),
    getCatalogItem('products', product._id, config),
    getCatalogItemBySlug('same-product', config),
  ]);
  const page = resultData<{ items: CollectionDoc[] }>(listResult);
  const byId = resultData<CollectionDoc>(idResult);
  const bySlug = resultData<CollectionDoc>(slugResult);
  const expected = projectPublicProduct({
    ...product,
    images: ['https://catalog.example.test/api/images/image-1'],
  });

  assert.ok(expected);
  assert.deepEqual(page.items, [expected]);
  assert.deepEqual(byId, expected);
  assert.deepEqual(bySlug, expected);
  assert.equal(Object.hasOwn(byId, 'vipPrice'), false);
  assert.equal(Object.hasOwn(byId, 'internalOnly'), false);
});
