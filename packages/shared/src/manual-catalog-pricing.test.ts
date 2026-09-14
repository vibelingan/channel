import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  MANUAL_CATALOG_PRICING_SCHEMA_VERSION,
  validateManualCatalogPricing,
} from './manual-catalog-pricing.ts';

const tiered = {
  schemaVersion: MANUAL_CATALOG_PRICING_SCHEMA_VERSION,
  currency: 'USD',
  tiers: [
    { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
    { minQuantity: 13, maxQuantity: 500, unitAmountMinor: 11_831 },
    { minQuantity: 501, unitAmountMinor: 8_292 },
  ],
} as const;

test('manual catalog pricing accepts one to four canonical quantity tiers', () => {
  const result = validateManualCatalogPricing(tiered);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, tiered);
  assert.equal(
    validateManualCatalogPricing({
      schemaVersion: MANUAL_CATALOG_PRICING_SCHEMA_VERSION,
      currency: 'CNY',
      tiers: [{ minQuantity: 5, unitAmountMinor: 0 }],
    }).ok,
    true,
  );
});

test('manual catalog pricing rejects malformed, overlapping, and excessive tiers', () => {
  const invalid: unknown[] = [
    null,
    { ...tiered, unknown: true },
    { ...tiered, currency: 'EUR' },
    { ...tiered, tiers: [] },
    {
      ...tiered,
      tiers: Array.from({ length: 5 }, (_, index) => ({
        minQuantity: index + 1,
        maxQuantity: index + 1,
        unitAmountMinor: 100,
      })),
    },
    { ...tiered, tiers: [{ minQuantity: 0, unitAmountMinor: 100 }] },
    { ...tiered, tiers: [{ minQuantity: 1, unitAmountMinor: -1 }] },
    { ...tiered, tiers: [{ minQuantity: 2, maxQuantity: 1, unitAmountMinor: 100 }] },
    {
      ...tiered,
      tiers: [
        { minQuantity: 1, maxQuantity: 10, unitAmountMinor: 100 },
        { minQuantity: 10, unitAmountMinor: 90 },
      ],
    },
    {
      ...tiered,
      tiers: [
        { minQuantity: 1, unitAmountMinor: 100 },
        { minQuantity: 2, unitAmountMinor: 90 },
      ],
    },
    { ...tiered, tiers: [{ minQuantity: 1, unitAmountMinor: 100, note: 'extra' }] },
  ];
  for (const value of invalid) {
    const result = validateManualCatalogPricing(value);
    assert.equal(result.ok, false, JSON.stringify(value));
  }
});

test('manual pricing allows gaps but requires strict ascending starts', () => {
  assert.equal(
    validateManualCatalogPricing({
      ...tiered,
      tiers: [
        { minQuantity: 1, maxQuantity: 5, unitAmountMinor: 100 },
        { minQuantity: 10, unitAmountMinor: 80 },
      ],
    }).ok,
    true,
  );
  assert.equal(
    validateManualCatalogPricing({
      ...tiered,
      tiers: [
        { minQuantity: 10, maxQuantity: 20, unitAmountMinor: 80 },
        { minQuantity: 1, maxQuantity: 5, unitAmountMinor: 100 },
      ],
    }).ok,
    false,
  );
});
