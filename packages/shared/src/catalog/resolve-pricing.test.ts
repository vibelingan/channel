import assert from 'node:assert/strict';
import test from 'node:test';
import type { AlibabaPricingAdapter } from './alibaba-pricing-adapter.ts';
import { resolveCatalogPricing } from './resolve-pricing.ts';

const manualPricing = {
  schemaVersion: 'manual-catalog-pricing-v1',
  currency: 'USD',
  tiers: [
    { minQuantity: 1, maxQuantity: 99, unitAmountMinor: 1200 },
    { minQuantity: 100, unitAmountMinor: 1000 },
  ],
} as const;

test('unlinked precedence is manual tiers, wholesale, unit, then quote', () => {
  const unusedAdapter: AlibabaPricingAdapter = {
    resolve() {
      assert.fail('unlinked pricing must not call Alibaba adapter');
    },
  };

  assert.deepEqual(
    resolveCatalogPricing(
      { manualCatalogPricing: manualPricing, wholesalePrice: 9, unitPrice: 12 },
      unusedAdapter,
    ),
    { source: 'manual-tiered', pricing: manualPricing },
  );
  assert.deepEqual(resolveCatalogPricing({ wholesalePrice: 0, unitPrice: 12.5 }, unusedAdapter), {
    source: 'scalar',
    field: 'wholesalePrice',
    amount: 0,
    currency: 'USD',
  });
  assert.deepEqual(resolveCatalogPricing({ unitPrice: 12.5 }, unusedAdapter), {
    source: 'scalar',
    field: 'unitPrice',
    amount: 12.5,
    currency: 'USD',
  });
  assert.deepEqual(resolveCatalogPricing({}, unusedAdapter), { source: 'quote-required' });
});

test('malformed manual and scalar values fail over only within the unlinked chain', () => {
  const unusedAdapter: AlibabaPricingAdapter = {
    resolve() {
      assert.fail('unlinked pricing must not call Alibaba adapter');
    },
  };
  for (const product of [
    { manualCatalogPricing: { ...manualPricing, tiers: [] }, wholesalePrice: -1, unitPrice: -2 },
    {
      manualCatalogPricing: {
        ...manualPricing,
        tiers: [{ minQuantity: 1, unitAmountMinor: 1.5 }],
      },
      wholesalePrice: Number.NaN,
      unitPrice: Number.POSITIVE_INFINITY,
    },
    { manualCatalogPricing: '', wholesalePrice: '', unitPrice: null },
  ]) {
    assert.deepEqual(resolveCatalogPricing(product, unusedAdapter), { source: 'quote-required' });
  }
});

test('linked inputs delegate first and return Alibaba unavailable without inspecting fallbacks', () => {
  const calls: Array<{ link: unknown; provider: unknown }> = [];
  const adapter: AlibabaPricingAdapter = {
    resolve(link, provider) {
      calls.push({ link, provider });
      return { source: 'alibaba', state: 'unavailable', mode: 'unavailable' };
    },
  };
  const manualCatalogPricing = new Proxy(
    {},
    {
      ownKeys() {
        assert.fail('manual fallback was inspected');
      },
    },
  );
  const product = {
    alibabaPrimarySourceKey: 'linked',
    alibabaCatalogPricing: undefined,
    manualCatalogPricing,
    wholesalePrice: 1,
    unitPrice: 2,
  };

  assert.deepEqual(resolveCatalogPricing(product, adapter), {
    source: 'alibaba',
    pricing: { source: 'alibaba', state: 'unavailable', mode: 'unavailable' },
  });
  assert.deepEqual(calls, [{ link: 'linked', provider: undefined }]);
});

test('present but malformed link identity remains Alibaba-owned and never falls back', () => {
  let calls = 0;
  const adapter: AlibabaPricingAdapter = {
    resolve() {
      calls += 1;
      return { source: 'alibaba', state: 'unavailable', mode: 'unavailable' };
    },
  };
  assert.deepEqual(
    resolveCatalogPricing(
      { alibabaPrimarySourceKey: '', manualCatalogPricing: manualPricing, wholesalePrice: 1 },
      adapter,
    ),
    {
      source: 'alibaba',
      pricing: { source: 'alibaba', state: 'unavailable', mode: 'unavailable' },
    },
  );
  assert.equal(calls, 1);
});
