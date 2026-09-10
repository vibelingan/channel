import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { effectiveCatalogPricing } from '../shop/catalog-pricing.ts';
import { ProductPricingEditor } from './ProductPricingEditor.tsx';
import { adminCatalogPricingInput, manualPricingSeed } from './product-pricing-editor.ts';

const source = {
  schemaVersion: 'alibaba-catalog-pricing-v1',
  source: 'alibaba',
  mode: 'tiered',
  currency: 'USD',
  tiers: [
    { minQuantity: 2, maxQuantity: 499, unitAmountMinor: 570 },
    { minQuantity: 500, unitAmountMinor: 500 },
  ],
  sourceMoq: 10,
  syncedAt: '2026-09-03T08:16:00.000Z',
  sourceOfferKey: 'private-reference',
};

const sourceReview = {
  schemaVersion: 'alibaba-source-review-v1',
  provider: 'alibaba',
  externalProductId: 'untouched',
  sourceListingStatus: 'published',
  variantCount: 2,
  offerCount: 2,
  modelNumbers: [],
  optionNames: ['Color'],
  minimumOrderQuantity: 10,
  primaryPricing: {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 10,
    tiers: [
      { minimumQuantity: 10, maximumQuantity: 99, unitAmountMinor: 789 },
      { minimumQuantity: 100, unitAmountMinor: 600 },
    ],
  },
};

function renderUntouchedPricing(
  state: Record<string, string | boolean>,
  review: unknown = sourceReview,
) {
  return renderToStaticMarkup(
    createElement(ProductPricingEditor, {
      initial: { alibabaPrimarySourceKey: 'source-key', alibabaSourceReview: review },
      state,
      onChange: () => {},
      onValidityChange: () => {},
    }),
  );
}

test('untouched draft Edit shows existing source tiers without a contradictory unavailable price', () => {
  const html = renderUntouchedPricing({ catalogPricingMode: 'source' });
  assert.match(html, /Synced source quote/);
  assert.match(html, /10–99/);
  assert.match(html, /7\.89/);
  assert.match(html, /100\+/);
  assert.doesNotMatch(html, /Pricing unavailable/);
  assert.doesNotMatch(html, /Source quotation for comparison/);
});

test('source evidence must not replace an explicit invalid manual price or missing source', () => {
  const manual = renderUntouchedPricing({ catalogPricingMode: 'manual' });
  assert.match(manual, /Enter a valid manual price/);
  assert.match(manual, /Source quotation for comparison/);
  const removed = renderUntouchedPricing(
    { catalogPricingMode: 'source' },
    {
      ...sourceReview,
      sourceListingStatus: 'missing',
    },
  );
  assert.match(removed, /Pricing unavailable/);
});

test('effective editor quote retains source MOQ when price is unavailable', () => {
  const html = renderUntouchedPricing(
    { catalogPricingMode: 'source' },
    {
      ...sourceReview,
      minimumOrderQuantity: 1,
      primaryPricing: { mode: 'unavailable', minimumOrderQuantity: 1 },
    },
  );
  assert.match(html, /Minimum order quantity: 1/);
  assert.match(html, /Pricing unavailable/);
  assert.doesNotMatch(html, /USD 0\.00|\$0\.00/);
});

test('unsaved pricing form values are labelled as a preview, not the current live price', () => {
  const html = renderToStaticMarkup(
    createElement(ProductPricingEditor, {
      initial: { alibabaPrimarySourceKey: 'source-key', alibabaCatalogPricing: source },
      state: { catalogPricingMode: 'manual', unitPrice: '6.2', wholesalePrice: '6.2' },
      onChange: () => {},
      onValidityChange: () => {},
    }),
  );
  assert.match(html, /Website price preview/);
  assert.doesNotMatch(html, /Currently shown on the website/);
});

test('admin pricing strips private provenance and resolves the same public price', () => {
  const input = adminCatalogPricingInput({
    alibabaPrimarySourceKey: 'source-key',
    alibabaCatalogPricing: source,
  });
  assert.equal(JSON.stringify(input).includes('private-reference'), false);
  assert.equal(effectiveCatalogPricing(input).source, 'alibaba');
  assert.deepEqual(manualPricingSeed(input), {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'USD',
    tiers: [
      { minQuantity: 10, maxQuantity: 499, unitAmountMinor: 570 },
      { minQuantity: 500, unitAmountMinor: 500 },
    ],
  });
  assert.equal(source.tiers[0]?.minQuantity, 2);
});

test('source copy never invents a price, quantity break or silently drops excess tiers', () => {
  for (const raw of [
    undefined,
    null,
    '',
    [],
    {},
    { ...source, mode: 'range', tiers: undefined, minAmountMinor: 100, maxAmountMinor: 500 },
    {
      ...source,
      tiers: Array.from({ length: 5 }, (_, i) => ({
        minQuantity: i + 1,
        maxQuantity: i + 1,
        unitAmountMinor: 500,
      })),
      sourceMoq: 1,
    },
    { ...source, currency: 'invalid' },
    { ...source, tiers: [{ minQuantity: 1, unitAmountMinor: null }] },
  ]) {
    assert.equal(
      manualPricingSeed(
        adminCatalogPricingInput({ alibabaPrimarySourceKey: 'key', alibabaCatalogPricing: raw }),
      ),
      undefined,
    );
  }
});

test('existing manual pricing is retained when switching back from follow-source', () => {
  const manual = {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'CNY',
    tiers: [{ minQuantity: 20, unitAmountMinor: 310 }],
  };
  assert.deepEqual(
    manualPricingSeed({ catalogPricingMode: 'source', manualCatalogPricing: manual }),
    manual,
  );
});
