import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicDoc, publicItem, publicVariant } from './public-projection.ts';

test('row projection keeps public values and withholds private and future fields', () => {
  assert.deepEqual(
    publicItem(
      'products',
      {
        _id: 'p',
        name: 'Headset',
        productFamily: 'headphones',
        category: 'wired',
        skuCode: '  SKU-1  ',
        slug: '  My Headset  ',
        imageIds: ['image_1'],
        unitPrice: 12,
        published: true,
        vipPrice: 2,
        privateField: 'private',
        catalogContentGeneration: 99,
        updatedAt: '2026-10-29T00:00:00.000Z',
      },
      { apiBaseUrl: 'https://api.example/' },
    ),
    {
      kind: 'row',
      doc: {
        _id: 'p',
        images: ['https://api.example/api/images/image_1'],
        name: 'Headset',
        unitPrice: 12,
        published: true,
        productFamily: 'headphones',
        category: 'wired',
        skuCode: 'sku-1',
        slug: 'my-headset',
      },
    },
  );
});

test('approved projection uses approved content and never attaches the VIP tier', () => {
  assert.deepEqual(
    publicItem(
      'products',
      {
        _id: 'p',
        name: 'Unapproved name',
        description: 'Unapproved text',
        productFamily: 'misc',
        category: 'wired',
        unitPrice: 99,
        vipPrice: 1,
        imageIds: ['draft_image'],
        published: true,
        catalogDetailPublication: {
          state: 'approved',
          revision: 'r1',
          header: {
            _id: 'p',
            schemaVersion: 'catalog-product-detail-v1',
            name: 'Approved headset',
            descriptionText: 'Approved text',
            images: ['/api/images/approved_image'],
            facts: [],
            offers: [],
          },
          priceSummary: {
            source: 'website',
            pricing: {
              mode: 'fixed',
              currency: 'USD',
              amountMinor: 500,
              minimumOrderQuantity: 10,
            },
          },
          variantCount: 0,
        },
      },
      { enableCatalogDetail: true },
      { canSeeVipPricing: true },
    ),
    {
      kind: 'approved',
      doc: {
        _id: 'p',
        name: 'Approved headset',
        images: ['/api/images/approved_image'],
        published: true,
        description: 'Approved text',
        priceSummary: {
          source: 'website',
          pricing: {
            mode: 'fixed',
            currency: 'USD',
            amountMinor: 500,
            minimumOrderQuantity: 10,
          },
        },
        moq: 10,
        productFamily: 'misc',
      },
    },
  );
});

test('legacy row projection retains gated pricing only for an entitled viewer', () => {
  const row = { _id: 'p', name: 'Legacy headset', vipPrice: 4 };
  assert.deepEqual(publicDoc('products', row, {}), {
    _id: 'p',
    images: [],
    name: 'Legacy headset',
  });
  assert.deepEqual(publicDoc('products', row, {}, { canSeeVipPricing: true }), {
    _id: 'p',
    images: [],
    name: 'Legacy headset',
    vipPrice: 4,
  });
});

test('variant projection withholds source prices and shop inventory breakdowns', () => {
  assert.deepEqual(
    publicVariant({
      _id: 'v1',
      sku: 'Black',
      optionValues: { Colour: 'Black', invalid: 123 },
      inventoryState: 'known',
      inventoryQuantity: 7,
      sourceRegularPrice: 20,
      inventorySnapshots: [{ shop: 'private-shop' }],
    }),
    { id: 'v1', sku: 'Black', optionValues: { Colour: 'Black' }, inventory: 7 },
  );
  assert.deepEqual(publicVariant({ _id: 'v2', inventoryState: 'conflict', inventoryQuantity: 7 }), {
    id: 'v2',
    sku: '',
    optionValues: {},
  });
});
