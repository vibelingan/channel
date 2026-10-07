import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogOfferPricing } from './offer-pricing.ts';
import { CatalogPriceSummarySchema, derivePriceSummary } from './price-summary.ts';
import { CatalogDetailPublicationSchema } from './product-detail.ts';

const tiers: CatalogOfferPricing = {
  mode: 'tiered',
  currency: 'USD',
  minimumOrderQuantity: 10,
  tiers: [
    { minimumQuantity: 10, maximumQuantity: 499, unitAmountMinor: 130 },
    { minimumQuantity: 500, maximumQuantity: 999, unitAmountMinor: 122 },
    { minimumQuantity: 1000, unitAmountMinor: 120 },
  ],
};
const supplier = (pricing: CatalogOfferPricing) => ({ pricing });

test('a website price is the summary and wins over SKU and product prices', () => {
  assert.deepEqual(
    derivePriceSummary({
      websitePricing: supplier(tiers),
      offers: [supplier({ mode: 'fixed', currency: 'USD', amountMinor: 1 })],
      variants: [
        { id: 'a', offers: [supplier({ mode: 'fixed', currency: 'USD', amountMinor: 1 })] },
      ],
    }),
    { source: 'website', pricing: tiers },
  );
});

test('the cheapest priced SKU supplies the summary, ties going to the earliest SKU', () => {
  const fixed: CatalogOfferPricing = { mode: 'fixed', currency: 'USD', amountMinor: 125 };
  assert.deepEqual(
    derivePriceSummary({
      offers: [],
      variants: [
        { id: 'b', offers: [supplier(fixed)] },
        { id: 'a', offers: [supplier(tiers)] },
        { id: 'c', offers: [supplier({ ...tiers })] },
      ],
    }),
    { source: 'sku', variantId: 'a', pricing: tiers },
  );
});

test('USD is preferred over CNY before amounts are compared', () => {
  const usd: CatalogOfferPricing = { mode: 'fixed', currency: 'USD', amountMinor: 500 };
  const cny: CatalogOfferPricing = { mode: 'fixed', currency: 'CNY', amountMinor: 300 };
  assert.deepEqual(
    derivePriceSummary({
      offers: [],
      variants: [
        { id: 'cny', offers: [supplier(cny)] },
        { id: 'usd', offers: [supplier(usd)] },
      ],
    }),
    { source: 'sku', variantId: 'usd', pricing: usd },
  );
});

test('with no priced SKU the product-level price is the summary', () => {
  const product: CatalogOfferPricing = { mode: 'fixed', currency: 'USD', amountMinor: 400 };
  assert.deepEqual(
    derivePriceSummary({
      offers: [supplier(product)],
      variants: [{ id: 'a', offers: [supplier({ mode: 'unavailable' })] }],
    }),
    { source: 'product', pricing: product },
  );
});

test('a minimum order without a price still produces a website summary (DEC-16)', () => {
  const moqOnly: CatalogOfferPricing = { mode: 'unavailable', minimumOrderQuantity: 50 };
  assert.deepEqual(
    derivePriceSummary({ websitePricing: supplier(moqOnly), offers: [], variants: [] }),
    { source: 'website', pricing: moqOnly },
  );
});

test('an authoritative website "request a quote" never falls back to supplier prices', () => {
  assert.equal(
    derivePriceSummary({
      websitePricing: supplier({ mode: 'unavailable' }),
      offers: [supplier({ mode: 'fixed', currency: 'USD', amountMinor: 400 })],
      variants: [{ id: 'a', offers: [supplier(tiers)] }],
    }),
    undefined,
  );
});

test('nothing priced and no minimum order gives no summary', () => {
  assert.equal(
    derivePriceSummary({
      offers: [supplier({ mode: 'negotiable' })],
      variants: [{ id: 'a', offers: [supplier({ mode: 'unavailable' })] }],
    }),
    undefined,
  );
});

test('summary schema is strict and the publication accepts it only at top level', () => {
  assert.ok(CatalogPriceSummarySchema.safeParse({ source: 'website', pricing: tiers }).success);
  assert.equal(
    CatalogPriceSummarySchema.safeParse({ source: 'website', pricing: tiers, extra: 1 }).success,
    false,
  );
  const publication = {
    state: 'approved',
    revision: 'r1',
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p1',
      name: 'Headset',
      images: [],
      facts: [],
      offers: [],
    },
    variantCount: 0,
  };
  assert.ok(CatalogDetailPublicationSchema.safeParse(publication).success);
  assert.ok(
    CatalogDetailPublicationSchema.safeParse({
      ...publication,
      priceSummary: { source: 'website', pricing: tiers },
    }).success,
  );
  assert.equal(
    CatalogDetailPublicationSchema.safeParse({
      ...publication,
      priceSummary: { source: 'website', pricing: tiers, extra: 1 },
    }).success,
    false,
  );
  assert.equal(
    CatalogDetailPublicationSchema.safeParse({
      ...publication,
      header: { ...publication.header, priceSummary: { source: 'website', pricing: tiers } },
    }).success,
    false,
  );
});

test('tiers below the minimum order are ignored, as the product page ignores them', () => {
  const belowMoq: CatalogOfferPricing = {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 100,
    tiers: [
      { minimumQuantity: 1, maximumQuantity: 99, unitAmountMinor: 50 },
      { minimumQuantity: 100, unitAmountMinor: 80 },
    ],
  };
  const cheaperElsewhere: CatalogOfferPricing = { mode: 'fixed', currency: 'USD', amountMinor: 70 };
  assert.deepEqual(
    derivePriceSummary({
      offers: [],
      variants: [
        { id: 'a', offers: [supplier(belowMoq)] },
        { id: 'b', offers: [supplier(cheaperElsewhere)] },
      ],
    }),
    { source: 'sku', variantId: 'b', pricing: cheaperElsewhere },
  );
});

test('currency ranking ignores letter case; range prices compare by their minimum', () => {
  const lowerUsd: CatalogOfferPricing = { mode: 'fixed', currency: 'usd', amountMinor: 900 };
  const range: CatalogOfferPricing = {
    mode: 'range',
    currency: 'CNY',
    minimumAmountMinor: 100,
    maximumAmountMinor: 200,
  };
  assert.equal(
    derivePriceSummary({
      offers: [],
      variants: [
        { id: 'cny', offers: [supplier(range)] },
        { id: 'usd', offers: [supplier(lowerUsd)] },
      ],
    })?.variantId,
    'usd',
  );
});

test('a priced SKU in any currency wins over a product-level price, as on the product page', () => {
  const cny: CatalogOfferPricing = { mode: 'fixed', currency: 'CNY', amountMinor: 3000 };
  assert.deepEqual(
    derivePriceSummary({
      offers: [supplier({ mode: 'fixed', currency: 'USD', amountMinor: 400 })],
      variants: [{ id: 'a', offers: [supplier(cny)] }],
    }),
    { source: 'sku', variantId: 'a', pricing: cny },
  );
});

test('with no price anywhere, a minimum order still gives a summary (product first, then first SKU)', () => {
  const moq = (n: number): CatalogOfferPricing => ({
    mode: 'unavailable',
    minimumOrderQuantity: n,
  });
  assert.deepEqual(
    derivePriceSummary({
      offers: [supplier(moq(50))],
      variants: [{ id: 'a', offers: [supplier(moq(10))] }],
    }),
    { source: 'product', pricing: moq(50) },
  );
  assert.deepEqual(
    derivePriceSummary({
      offers: [],
      variants: [
        { id: 'a', offers: [supplier({ mode: 'unavailable' })] },
        { id: 'b', offers: [supplier({ mode: 'negotiable', minimumOrderQuantity: 20 })] },
      ],
    }),
    {
      source: 'sku',
      variantId: 'b',
      pricing: { mode: 'negotiable', minimumOrderQuantity: 20 },
    },
  );
});

test('the summary schema ties variantId to SKU summaries and refuses empty price-less summaries', () => {
  const fixed = { mode: 'fixed', currency: 'USD', amountMinor: 1 };
  assert.equal(
    CatalogPriceSummarySchema.safeParse({ source: 'sku', pricing: fixed }).success,
    false,
  );
  assert.equal(
    CatalogPriceSummarySchema.safeParse({ source: 'product', variantId: 'a', pricing: fixed })
      .success,
    false,
  );
  assert.equal(
    CatalogPriceSummarySchema.safeParse({ source: 'product', pricing: { mode: 'unavailable' } })
      .success,
    false,
  );
  assert.ok(
    CatalogPriceSummarySchema.safeParse({
      source: 'website',
      pricing: { mode: 'negotiable', minimumOrderQuantity: 5 },
    }).success,
  );
});
