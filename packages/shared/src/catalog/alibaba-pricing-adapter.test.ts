import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlibabaPricingAdapter } from './alibaba-pricing-adapter.ts';

const base = {
  schemaVersion: 'alibaba-catalog-pricing-v1',
  source: 'alibaba',
  syncedAt: '2026-08-25T00:00:00.000Z',
} as const;
const adapter = createAlibabaPricingAdapter();

test('maps fixed, range, and tiered provider data to bounded minor-unit decisions', () => {
  assert.deepEqual(
    adapter.resolve('linked', {
      ...base,
      mode: 'fixed',
      currency: 'USD',
      amountMinor: 250,
      sourceMoq: 100,
    }),
    {
      source: 'alibaba',
      state: 'available',
      mode: 'fixed',
      currency: 'USD',
      amountMinor: 250,
      sourceMoq: 100,
    },
  );
  assert.deepEqual(
    adapter.resolve('linked', {
      ...base,
      mode: 'range',
      currency: 'CNY',
      minAmountMinor: 150,
      maxAmountMinor: 230,
    }),
    {
      source: 'alibaba',
      state: 'available',
      mode: 'range',
      currency: 'CNY',
      minAmountMinor: 150,
      maxAmountMinor: 230,
    },
  );
  assert.deepEqual(
    adapter.resolve('linked', {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      sourceMoq: 50,
      tiers: [
        { minQuantity: 50, maxQuantity: 499, unitAmountMinor: 250 },
        { minQuantity: 500, unitAmountMinor: 115 },
      ],
    }),
    {
      source: 'alibaba',
      state: 'available',
      mode: 'tiered',
      currency: 'USD',
      sourceMoq: 50,
      tiers: [
        { minQuantity: 50, maxQuantity: 499, unitAmountMinor: 250 },
        { minQuantity: 500, unitAmountMinor: 115 },
      ],
    },
  );
});

test('maps negotiable to quote and explicit unavailable to provider-owned unavailable', () => {
  assert.deepEqual(adapter.resolve('linked', { ...base, mode: 'negotiable' }), {
    source: 'alibaba',
    state: 'quote',
    mode: 'negotiable',
  });
  assert.deepEqual(adapter.resolve('linked', { ...base, mode: 'unavailable', sourceMoq: 20 }), {
    source: 'alibaba',
    state: 'unavailable',
    mode: 'unavailable',
    sourceMoq: 20,
  });
});

test('linked missing or malformed provider data never exposes fallback fields', () => {
  for (const provider of [
    undefined,
    { ...base, mode: 'fixed', currency: 'USD', amountMinor: -1, unitPrice: 99 },
    { ...base, mode: 'range', currency: 'USD', minAmountMinor: 300, maxAmountMinor: 200 },
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minQuantity: 100, maxQuantity: 200, unitAmountMinor: 250 },
        { minQuantity: 200, unitAmountMinor: 200 },
      ],
      manualCatalogPricing: { tiers: [{ minQuantity: 1, unitAmountMinor: 1 }] },
    },
  ]) {
    const decision = adapter.resolve('linked', provider);
    assert.deepEqual(decision, {
      source: 'alibaba',
      state: 'unavailable',
      mode: 'unavailable',
    });
    assert.equal('unitPrice' in decision, false);
    assert.equal('manualCatalogPricing' in decision, false);
  }
});

test('invalid link identity fails closed to Alibaba unavailable', () => {
  assert.deepEqual(adapter.resolve('', { ...base, mode: 'negotiable' }), {
    source: 'alibaba',
    state: 'unavailable',
    mode: 'unavailable',
  });
});

test('rejects malformed timestamps and contradictory mode fields', () => {
  for (const provider of [
    { ...base, syncedAt: 'yesterday', mode: 'negotiable' },
    { ...base, sourceUpdatedAt: '2026-08-25 00:00:00', mode: 'negotiable' },
    {
      ...base,
      mode: 'fixed',
      currency: 'USD',
      amountMinor: 250,
      minAmountMinor: 100,
    },
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      sourceMoq: 50,
      tiers: [{ minQuantity: 100, unitAmountMinor: 250 }],
    },
    {
      ...base,
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minQuantity: 1, unitAmountMinor: 250 },
        { minQuantity: 10, unitAmountMinor: 200 },
      ],
    },
  ]) {
    assert.deepEqual(adapter.resolve('linked', provider), {
      source: 'alibaba',
      state: 'unavailable',
      mode: 'unavailable',
    });
  }
});

test('tier decisions do not alias provider arrays or tier objects', () => {
  const provider = {
    ...base,
    mode: 'tiered',
    currency: 'USD',
    tiers: [{ minQuantity: 1, unitAmountMinor: 250 }],
  } as const;
  const decision = adapter.resolve('linked', provider);
  assert.equal(decision.state, 'available');
  if (decision.state !== 'available' || decision.mode !== 'tiered') return;
  assert.notEqual(decision.tiers, provider.tiers);
  assert.notEqual(decision.tiers[0], provider.tiers[0]);
  const firstTier = decision.tiers[0];
  assert.ok(firstTier);
  firstTier.unitAmountMinor = 100;
  assert.equal(provider.tiers[0]?.unitAmountMinor, 250);
});
