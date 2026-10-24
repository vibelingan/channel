import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManualCatalogPricing } from '../manual-catalog-pricing.ts';
import type { AlibabaPricingAdapter } from './alibaba-pricing-adapter.ts';
import { type CatalogPricingDecision, resolveCatalogPricing } from './resolve-pricing.ts';

const manualPricing: ManualCatalogPricing = {
  schemaVersion: 'manual-catalog-pricing-v1',
  currency: 'USD',
  tiers: [
    { minQuantity: 1, maxQuantity: 99, unitAmountMinor: 1200 },
    { minQuantity: 100, unitAmountMinor: 1000 },
  ],
};

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
  assert.deepEqual(
    resolveCatalogPricing(
      { manualCatalogPricing: { ...manualPricing, tiers: [] }, wholesalePrice: 4 },
      unusedAdapter,
    ),
    { source: 'scalar', field: 'wholesalePrice', amount: 4, currency: 'USD' },
  );
  assert.deepEqual(resolveCatalogPricing({ wholesalePrice: -1, unitPrice: 3.5 }, unusedAdapter), {
    source: 'scalar',
    field: 'unitPrice',
    amount: 3.5,
    currency: 'USD',
  });
});

test('explicit source mode ignores retained manual prices without inspecting them', () => {
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
    catalogPricingMode: 'source',
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

test('manual intervention wins even when the source link is malformed', () => {
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
    { source: 'manual-tiered', pricing: manualPricing },
  );
  assert.equal(calls, 0);
});

test('linked products prefer valid manual pricing and only inherit source when absent', () => {
  const adapter: AlibabaPricingAdapter = {
    resolve: () => ({ source: 'alibaba', state: 'quote', mode: 'negotiable' }),
  };
  const linked = { alibabaPrimarySourceKey: 'linked' };
  assert.equal(
    resolveCatalogPricing({ ...linked, manualCatalogPricing: manualPricing }, adapter).source,
    'manual-tiered',
  );
  assert.deepEqual(resolveCatalogPricing({ ...linked, wholesalePrice: 0 }, adapter), {
    source: 'scalar',
    field: 'wholesalePrice',
    amount: 0,
    currency: 'USD',
  });
  for (const empty of [undefined, null, '', 'invalid', {}, []]) {
    assert.equal(
      resolveCatalogPricing({ ...linked, manualCatalogPricing: empty }, adapter).source,
      'alibaba',
    );
    assert.deepEqual(
      resolveCatalogPricing(
        { ...linked, catalogPricingMode: 'manual', manualCatalogPricing: empty },
        adapter,
      ),
      { source: 'quote-required' },
    );
  }
  assert.deepEqual(
    resolveCatalogPricing({ ...linked, catalogPricingMode: 'typo', unitPrice: 3 }, adapter),
    { source: 'quote-required' },
  );
  assert.deepEqual(resolveCatalogPricing({ catalogPricingMode: 'source', unitPrice: 3 }, adapter), {
    source: 'quote-required',
  });
});

test('manual-tier decisions do not alias input arrays or tier objects', () => {
  const pricing = {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'USD',
    tiers: [{ minQuantity: 1, unitAmountMinor: 1200 }],
  } as const;
  const adapter: AlibabaPricingAdapter = {
    resolve() {
      assert.fail('unlinked pricing must not call Alibaba adapter');
    },
  };
  const decision = resolveCatalogPricing({ manualCatalogPricing: pricing }, adapter);
  assert.equal(decision.source, 'manual-tiered');
  if (decision.source !== 'manual-tiered') return;
  assert.notEqual(decision.pricing.tiers, pricing.tiers);
  assert.notEqual(decision.pricing.tiers[0], pricing.tiers[0]);
});

test('consumer switch is exhaustive across every pricing source', () => {
  function sourceLabel(decision: CatalogPricingDecision): string {
    switch (decision.source) {
      case 'alibaba':
        return decision.pricing.state;
      case 'manual-tiered':
        return decision.pricing.currency;
      case 'scalar':
        return decision.field;
      case 'quote-required':
        return decision.source;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  }

  const decisions: CatalogPricingDecision[] = [
    { source: 'alibaba', pricing: { source: 'alibaba', state: 'quote', mode: 'negotiable' } },
    { source: 'manual-tiered', pricing: manualPricing },
    { source: 'scalar', field: 'unitPrice', amount: 1, currency: 'USD' },
    { source: 'quote-required' },
  ];
  assert.deepEqual(decisions.map(sourceLabel), ['quote', 'USD', 'unitPrice', 'quote-required']);
});

test('a manual scalar with unsupported precision never becomes a source fallback', () => {
  const adapter: AlibabaPricingAdapter = {
    resolve() {
      assert.fail('invalid manual override must not inherit source');
    },
  };
  assert.deepEqual(
    resolveCatalogPricing({ unitPrice: 1.234, alibabaPrimarySourceKey: 'linked' }, adapter),
    { source: 'quote-required' },
  );
});
