/** The hub's featured strip shows the same MOQ as the catalog card (MIU-13). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CatalogContent } from '../../i18n/catalog.ts';
import { FeaturedProductCard } from './FeaturedProducts.tsx';
import type { Product } from './catalog-types.ts';

const content = { list: { moqLabel: 'MOQ' } } as CatalogContent;
const render = (product: Product) =>
  renderToStaticMarkup(createElement(FeaturedProductCard, { product, content }));

test('an approved product shows the summary MOQ', () => {
  const markup = render({
    _id: 'approved',
    name: 'Approved',
    slug: 'approved',
    moq: 10,
    priceSummary: {
      source: 'website',
      pricing: {
        mode: 'tiered',
        currency: 'USD',
        tiers: [{ minimumQuantity: 10, unitAmountMinor: 120 }],
      },
    },
  });
  assert.match(markup, />MOQ 10</);
});

test('a row-fallback product shows the effective MOQ (first manual tier), not the raw row moq', () => {
  const markup = render({
    _id: 'manual',
    name: 'Manual',
    slug: 'manual',
    moq: 2,
    catalogPricingMode: 'manual',
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [{ minQuantity: 20, unitAmountMinor: 500 }],
    },
  } as Product);
  assert.match(markup, />MOQ 20</);
  assert.doesNotMatch(markup, />MOQ 2</);
});

test('a product without any MOQ renders no MOQ line', () => {
  assert.doesNotMatch(render({ _id: 'none', name: 'None', slug: 'none' }), /MOQ/);
});
