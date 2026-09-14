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
