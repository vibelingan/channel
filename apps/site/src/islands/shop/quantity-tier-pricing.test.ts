import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManualCatalogPricing } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { createAlibabaCatalogPricing, createProduct } from '../../test/factories/catalog.ts';
import { catalogProductPrice } from './CatalogFamilyGrid.tsx';
import { HeadphonesProductDetail } from './HeadphonesProductDetail.tsx';
import { QuantityTierPricingBlock, quantityTierPriceSummary } from './QuantityTierPricingBlock.tsx';
import type { Product } from './catalog-types.ts';

const pricing: ManualCatalogPricing = {
  schemaVersion: 'manual-catalog-pricing-v1',
  currency: 'USD',
  tiers: [
    { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
    { minQuantity: 13, unitAmountMinor: 11_831 },
  ],
};

const DETAIL: HeadphonesContent['detail'] = {
  backLabel: 'Back',
  backToModelsLabel: 'Back to models',
  seriesLabel: 'Series',
  modelLabel: 'Model',
  typeLabel: 'Type',
  moqLabel: 'Minimum Order Quantity',
  unitPriceLabel: 'Unit price',
  wholesaleLabel: 'Wholesale price',
  inquiryCta: 'Price inquiry',
  oemInquiryCta: 'Start Your OEM Enquiry',
  viewAllLabel: 'View All',
  showLessLabel: 'Show Less',
  imageUnavailableLabel: 'Image unavailable',
  notFound: 'Product not found.',
};

function tieredProduct(overrides: Partial<Product> = {}): Product {
  return createProduct({ manualCatalogPricing: pricing, ...overrides });
}

function renderDetail(product: Product): string {
  return renderToStaticMarkup(
    createElement(HeadphonesProductDetail, {
      product,
      detail: DETAIL,
      categoryLabel: 'Studio',
      onBack: () => undefined,
    }),
  );
}

test('manual tier summary uses explicit currency and the lowest visible unit price', () => {
  assert.equal(quantityTierPriceSummary(pricing), 'From $118.31');
  assert.equal(quantityTierPriceSummary({ ...pricing, currency: 'CNY' }), 'From CN¥118.31');
});

test('detail block renders every quantity range and exact unit amount', () => {
  const html = renderToStaticMarkup(createElement(QuantityTierPricingBlock, { pricing }));
  assert.match(html, /data-manual-tier-pricing/);
  assert.match(html, /1–12/);
  assert.match(html, /13\+/);
  assert.match(html, /\$134\.18/);
  assert.match(html, /\$118\.31/);
});

test('manual tiers take precedence over scalar prices on card and detail', () => {
  const product = tieredProduct({ unitPrice: 99, wholesalePrice: 88 });
  assert.equal(catalogProductPrice(product, 'Price inquiry'), 'From $118.31');
  const detail = renderDetail(product);
  assert.match(detail, /data-manual-tier-pricing/);
  assert.doesNotMatch(detail, /\$88\.00|\$99\.00/);
});

test('Alibaba-linked products suppress manual tiers and scalar fallback', () => {
  const product = tieredProduct({
    alibabaPrimarySourceKey: 'linked',
    alibabaCatalogPricing: createAlibabaCatalogPricing({ amountMinor: 250 }),
    unitPrice: 99,
    wholesalePrice: 88,
  });
  assert.equal(catalogProductPrice(product, 'Price inquiry'), '$2.50');
  const detail = renderDetail(product);
  assert.match(detail, /data-alibaba-pricing/);
  assert.doesNotMatch(detail, /data-manual-tier-pricing|\$88\.00|\$99\.00/);
});
