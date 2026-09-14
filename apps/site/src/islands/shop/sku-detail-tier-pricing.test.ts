import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CatalogContent } from '../../i18n/catalog.ts';
import { createProduct } from '../../test/factories/catalog.ts';
import { SkuDetailView } from './SkuDetailPage.tsx';

const content = {
  list: { moqLabel: 'MOQ' },
  detail: {
    inquiryCta: 'Request a quote',
    oemEyebrow: 'OEM',
    oemHeading: 'Build your product',
    oemBody: 'Talk to our team.',
    relatedHeading: 'Related products',
  },
} as CatalogContent;

test('slug detail renders the full manual tier table ahead of scalar prices', () => {
  const product = createProduct({
    productFamily: 'toys',
    slug: 'tiered-toy',
    skuCode: undefined,
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [
        { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
        { minQuantity: 13, unitAmountMinor: 11_831 },
      ],
    },
    unitPrice: 99,
    wholesalePrice: 88,
  });
  const html = renderToStaticMarkup(
    createElement(SkuDetailView, {
      content,
      state: { status: 'ready', product, related: [] },
      onRetry: () => undefined,
    }),
  );
  assert.match(html, /data-manual-tier-pricing/);
  assert.match(html, /1–12|1&#x2013;12/);
  assert.match(html, /13\+/);
  assert.doesNotMatch(html, /\$88\.00|\$99\.00/);
});
