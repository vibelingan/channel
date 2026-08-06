import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type AlibabaCatalogPricing, validateAlibabaCatalogPricing } from './alibaba-pricing.ts';

const base = {
  schemaVersion: 'alibaba-catalog-pricing-v1',
  source: 'alibaba',
  syncedAt: '2026-08-06T07:00:00.000Z',
};

const valid = (value: unknown): AlibabaCatalogPricing => {
  const result = validateAlibabaCatalogPricing(value);
  assert.equal(
    result.ok,
    true,
    `expected valid, got: ${result.ok === false ? result.errors.join('; ') : ''}`,
  );
  if (!result.ok) throw new Error('unreachable');
  return result.value;
};

const invalid = (value: unknown, errorSubstring: string) => {
  const result = validateAlibabaCatalogPricing(value);
  assert.equal(result.ok, false, `expected invalid for ${JSON.stringify(value)}`);
  if (result.ok === false) {
    assert.ok(
      result.errors.some((e) => e.includes(errorSubstring)),
      `expected an error containing ${JSON.stringify(errorSubstring)}, got: ${result.errors.join('; ')}`,
    );
  }
};

// --- happy paths per mode ---------------------------------------------------

test('accepts a fixed price', () => {
  valid({ ...base, mode: 'fixed', currency: 'USD', amountMinor: 1999 });
});

test('accepts a range price', () => {
  valid({ ...base, mode: 'range', currency: 'CNY', minAmountMinor: 100, maxAmountMinor: 250 });
});

test('accepts an equal-bounds range', () => {
  valid({ ...base, mode: 'range', currency: 'USD', minAmountMinor: 100, maxAmountMinor: 100 });
});

test('accepts tiered pricing with an open-ended final tier', () => {
  valid({
    ...base,
    mode: 'tiered',
    currency: 'USD',
    sourceMoq: 10,
    tiers: [
      { minQuantity: 10, maxQuantity: 99, unitAmountMinor: 500 },
      { minQuantity: 100, maxQuantity: 499, unitAmountMinor: 450 },
      { minQuantity: 500, unitAmountMinor: 400 },
    ],
  });
});

test('accepts negotiable with and without currency', () => {
  valid({ ...base, mode: 'negotiable' });
  valid({ ...base, mode: 'negotiable', currency: 'USD' });
});

test('accepts unavailable without currency (currency-less source)', () => {
  valid({ ...base, mode: 'unavailable' });
});

test('accepts optional provenance fields', () => {
  valid({
    ...base,
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 100,
    sourceMoq: 5,
    sourceOfferKey: 'abc',
    sourceProductId: '123',
    sourceSkuId: 'sku-1',
    sourceUpdatedAt: '2026-08-01T00:00:00Z',
  });
});

// --- structural rejections --------------------------------------------------

test('rejects non-objects and null', () => {
  invalid(null, 'object');
  invalid('fixed', 'object');
  invalid(42, 'object');
});

test('rejects wrong schemaVersion and source', () => {
  invalid({ ...base, schemaVersion: 'v2', mode: 'negotiable' }, 'schemaVersion');
  invalid({ ...base, source: '1688', mode: 'negotiable' }, 'source');
});

test('rejects unknown modes', () => {
  invalid({ ...base, mode: 'auction', currency: 'USD' }, 'mode');
});

test('rejects unknown keys (canonical shape is strict)', () => {
  invalid({ ...base, mode: 'negotiable', markup: 1.2 }, 'unknown key');
});

test('rejects missing or malformed syncedAt', () => {
  invalid(
    { schemaVersion: base.schemaVersion, source: base.source, mode: 'negotiable' },
    'syncedAt',
  );
  invalid({ ...base, syncedAt: 'yesterday', mode: 'negotiable' }, 'syncedAt');
  invalid({ ...base, syncedAt: '2026-08-06 07:00:00', mode: 'negotiable' }, 'syncedAt');
});

// --- currency rules ---------------------------------------------------------

test('amount-bearing modes require a valid currency', () => {
  invalid({ ...base, mode: 'fixed', amountMinor: 100 }, 'currency');
  invalid({ ...base, mode: 'range', minAmountMinor: 1, maxAmountMinor: 2 }, 'currency');
  invalid({ ...base, mode: 'tiered', tiers: [{ minQuantity: 1, unitAmountMinor: 5 }] }, 'currency');
  invalid({ ...base, mode: 'fixed', currency: 'EUR', amountMinor: 100 }, 'currency');
});

// --- per-mode field matrix (R1) --------------------------------------------

test('fixed forbids range, tier fields', () => {
  invalid(
    { ...base, mode: 'fixed', currency: 'USD', amountMinor: 1, minAmountMinor: 1 },
    'minAmountMinor',
  );
  invalid({ ...base, mode: 'fixed', currency: 'USD', amountMinor: 1, tiers: [] }, 'tiers');
  invalid({ ...base, mode: 'fixed', currency: 'USD' }, 'amountMinor');
});

test('range requires both bounds ordered and forbids amountMinor', () => {
  invalid({ ...base, mode: 'range', currency: 'USD', minAmountMinor: 5 }, 'maxAmountMinor');
  invalid(
    { ...base, mode: 'range', currency: 'USD', minAmountMinor: 5, maxAmountMinor: 4 },
    'minAmountMinor <= maxAmountMinor',
  );
  invalid(
    {
      ...base,
      mode: 'range',
      currency: 'USD',
      minAmountMinor: 1,
      maxAmountMinor: 2,
      amountMinor: 1,
    },
    'amountMinor',
  );
});

test('negotiable and unavailable forbid all numeric price fields', () => {
  invalid({ ...base, mode: 'negotiable', amountMinor: 1 }, 'amountMinor');
  invalid({ ...base, mode: 'unavailable', minAmountMinor: 1 }, 'minAmountMinor');
  invalid(
    { ...base, mode: 'unavailable', tiers: [{ minQuantity: 1, unitAmountMinor: 1 }] },
    'tiers',
  );
});

// --- money value rules ------------------------------------------------------

test('rejects negative, fractional, and unsafe amounts', () => {
  invalid({ ...base, mode: 'fixed', currency: 'USD', amountMinor: -1 }, 'amountMinor');
  invalid({ ...base, mode: 'fixed', currency: 'USD', amountMinor: 1.5 }, 'amountMinor');
  invalid(
    { ...base, mode: 'fixed', currency: 'USD', amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    'amountMinor',
  );
  invalid({ ...base, mode: 'fixed', currency: 'USD', amountMinor: Number.NaN }, 'amountMinor');
});

// --- tier rules -------------------------------------------------------------

test('rejects empty tiers and non-array tiers', () => {
  invalid({ ...base, mode: 'tiered', currency: 'USD', tiers: [] }, 'tiers');
  invalid({ ...base, mode: 'tiered', currency: 'USD', tiers: 'a-lot' }, 'tiers');
});

test('rejects non-positive and fractional tier quantities', () => {
  invalid(
    { ...base, mode: 'tiered', currency: 'USD', tiers: [{ minQuantity: 0, unitAmountMinor: 1 }] },
    'minQuantity',
  );
  invalid(
    { ...base, mode: 'tiered', currency: 'USD', tiers: [{ minQuantity: 1.5, unitAmountMinor: 1 }] },
    'minQuantity',
  );
});

test('rejects unsorted tiers and duplicate starts', () => {
  invalid(
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minQuantity: 100, maxQuantity: 199, unitAmountMinor: 4 },
        { minQuantity: 10, maxQuantity: 99, unitAmountMinor: 5 },
      ],
    },
    'sorted',
  );
  invalid(
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minQuantity: 10, maxQuantity: 99, unitAmountMinor: 5 },
        { minQuantity: 10, maxQuantity: 199, unitAmountMinor: 4 },
      ],
    },
    'sorted',
  );
});

test('rejects overlapping tiers', () => {
  invalid(
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minQuantity: 10, maxQuantity: 100, unitAmountMinor: 5 },
        { minQuantity: 100, maxQuantity: 199, unitAmountMinor: 4 },
      ],
    },
    'overlap',
  );
});

test('rejects an inverted tier window', () => {
  invalid(
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [{ minQuantity: 10, maxQuantity: 9, unitAmountMinor: 5 }],
    },
    'maxQuantity',
  );
});

test('rejects a non-final open-ended tier', () => {
  invalid(
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minQuantity: 10, unitAmountMinor: 5 },
        { minQuantity: 100, maxQuantity: 199, unitAmountMinor: 4 },
      ],
    },
    'open-ended',
  );
});

test('rejects a tiered price whose first tier exceeds sourceMoq', () => {
  invalid(
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      sourceMoq: 5,
      tiers: [{ minQuantity: 10, unitAmountMinor: 5 }],
    },
    'sourceMoq',
  );
});

test('rejects unknown keys inside a tier', () => {
  invalid(
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [{ minQuantity: 1, unitAmountMinor: 5, discount: 0.5 }],
    },
    'unknown key',
  );
});
