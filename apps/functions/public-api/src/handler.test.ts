import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicDoc } from './handler.ts';

const config = { apiBaseUrl: 'https://catalog.example.test' };

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

  assert.equal(projected.name, 'Interactive Toy');
  assert.equal(Object.hasOwn(projected, 'category'), false);
  assert.equal(Object.hasOwn(projected, 'manualCatalogPricing'), false);
});

test('public products never expose the private Alibaba source-review projection', () => {
  const projected = publicDoc(
    'products',
    {
      _id: 'alibaba-draft-1',
      name: 'Supplier draft',
      productFamily: 'headphones',
      published: false,
      alibabaSourceReview: {
        schemaVersion: 'alibaba-source-review-v1',
        provider: 'alibaba',
        externalProductId: 'supplier-product-id',
        sourceCategoryId: '201745901',
        modelNumbers: ['SY-T11'],
        optionNames: ['color'],
        variantCount: 3,
        offerCount: 3,
        minimumOrderQuantity: 2,
        primaryPricing: {
          mode: 'tiered',
          currency: 'USD',
          minimumOrderQuantity: 2,
          tiers: [{ minimumQuantity: 2, unitAmountMinor: 570 }],
        },
      },
    },
    config,
  );

  assert.equal(Object.hasOwn(projected, 'alibabaSourceReview'), false);
});
