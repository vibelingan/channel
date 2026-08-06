/**
 * Stage E acceptance matrix (COMPATIBILITY_AND_ACTIVATION_PLAN §3, R1):
 * the linked/unlinked branch applies at EVERY legacy price render site —
 * card unit-price badge, card moq, spec-sheet unitPrice row, spec-sheet moq
 * row, and PriceBlock — not just the renderer choice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import {
  createAlibabaCatalogPricing,
  createAlibabaLinkedProduct,
  createProduct,
} from '../../test/factories/catalog.ts';
import { HeadphonesProductCard } from './HeadphonesProductCard.tsx';
import { HeadphonesProductDetail } from './HeadphonesProductDetail.tsx';
import type { Product } from './catalog-types.ts';

const LIST: HeadphonesContent['list'] = {
  eyebrow: 'Catalog',
  heading: 'Headphones',
  subheading: 'Browse the range',
  filterLabel: 'Filter',
  allLabel: 'All',
  resultsLabel: 'results',
  loadingLabel: 'Loading',
  errorLabel: 'Error',
  retryLabel: 'Retry',
  emptyLabel: 'No products',
  emptyStateLabel: 'Nothing here yet',
  emptyCtaLabel: 'Clear filters',
  loadMoreLabel: 'Load more',
  loadingMoreLabel: 'Loading more',
  resultProgressLabel: 'Showing {shown} of {total}',
  categories: [{ key: 'all', label: 'All' }],
  wholesaleLabel: 'Wholesale',
  vipLabel: 'VIP',
  vipLockedLabel: 'Sign in',
  viewDetail: 'View details',
  moqLabel: 'MOQ',
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
  vipLabel: 'VIP price',
  vipLockedLabel: 'Sign in to view VIP price',
  inquiryCta: 'Price inquiry',
  oemInquiryCta: 'Start Your OEM Enquiry',
  viewAllLabel: 'View All',
  showLessLabel: 'Show Less',
  imageUnavailableLabel: 'Image unavailable',
  notFound: 'Product not found.',
};

const legacyProduct = (): Product =>
  createProduct({ moq: 1000, unitPrice: 18.9, wholesalePrice: 15.5, vipPrice: 13.2 });

const renderCard = (product: Product): string =>
  renderToStaticMarkup(
    createElement(HeadphonesProductCard, {
      product,
      list: LIST,
      imageUnavailableLabel: 'Image unavailable',
      onOpen: () => {},
    }),
  );

const renderDetail = (product: Product, registered = false): string =>
  renderToStaticMarkup(
    createElement(HeadphonesProductDetail, {
      product,
      detail: DETAIL,
      categoryLabel: 'True Wireless',
      registered,
      onBack: () => {},
    }),
  );

// --- unlinked: legacy behavior byte-stable -----------------------------------

test('MATRIX unlinked: card and detail render the legacy pricing surfaces unchanged', () => {
  const card = renderCard(legacyProduct());
  assert.ok(card.includes('data-product-card-price'));
  assert.ok(card.includes('$18.90'));
  assert.ok(card.includes('<strong>1000</strong>'));
  assert.ok(!card.includes('data-alibaba'), 'no alibaba markup on legacy cards');

  const detail = renderDetail(legacyProduct(), true);
  assert.ok(detail.includes('$18.90'), 'spec-sheet unit price');
  assert.ok(detail.includes('$15.50'), 'wholesale via PriceBlock');
  assert.ok(detail.includes('$13.20'), 'vip for registered viewer');
  assert.ok(!detail.includes('data-alibaba'), 'no alibaba markup on legacy detail');
});

// --- linked with pricing: Alibaba renderer everywhere ------------------------

test('MATRIX linked+priced: every legacy price surface is replaced by the Alibaba branch', () => {
  const product = createAlibabaLinkedProduct({
    moq: 1000,
    unitPrice: 18.9,
    wholesalePrice: 15.5,
    vipPrice: 13.2,
    alibabaCatalogPricing: createAlibabaCatalogPricing({ amountMinor: 250, sourceMoq: 100 }),
  });

  const card = renderCard(product);
  assert.ok(card.includes('data-alibaba-card-price'));
  assert.ok(card.includes('$2.50'));
  assert.ok(card.includes('<strong>100</strong>'), 'sourceMoq replaces legacy moq');
  assert.ok(!card.includes('data-product-card-price'), 'legacy price badge suppressed');
  assert.ok(!card.includes('$18.90'), 'legacy unit price never renders');
  assert.ok(!card.includes('<strong>1000</strong>'), 'legacy moq never renders');

  const detail = renderDetail(product, true);
  assert.ok(detail.includes('data-alibaba-pricing'));
  assert.ok(detail.includes('$2.50'));
  assert.ok(detail.includes('data-alibaba-source-moq'));
  assert.ok(!detail.includes('$18.90'), 'spec-sheet unit price suppressed');
  assert.ok(!detail.includes('$15.50'), 'PriceBlock wholesale suppressed');
  assert.ok(!detail.includes('$13.20'), 'VIP price suppressed even for registered viewers');
});

// --- linked without pricing: quote-required, NEVER legacy fallback -----------

test('MATRIX linked+missing: quote-required state renders and legacy values stay hidden', () => {
  const product = createAlibabaLinkedProduct({
    moq: 1000,
    unitPrice: 18.9,
    wholesalePrice: 15.5,
    alibabaCatalogPricing: undefined,
  });

  const card = renderCard(product);
  assert.ok(!card.includes('$18.90'), 'no legacy fallback on the card');
  assert.ok(!card.includes('data-product-card-price'));
  // The card is never silently price-less (review R2 #2): the quote-required
  // marker renders where the price would.
  assert.ok(card.includes('data-alibaba-card-unavailable'), 'card renders the unavailable label');

  const detail = renderDetail(product, true);
  assert.ok(detail.includes('data-alibaba-unavailable'), 'quote-required state renders');
  assert.ok(!detail.includes('$18.90'));
  assert.ok(!detail.includes('$15.50'));
});

test('MATRIX linked+unavailable-mode: explicit unavailable renders the same quote state', () => {
  const detail = renderDetail(
    createAlibabaLinkedProduct({
      unitPrice: 18.9,
      alibabaCatalogPricing: createAlibabaCatalogPricing({
        mode: 'unavailable',
        amountMinor: undefined as unknown as number,
        currency: undefined,
      }),
    }),
  );
  assert.ok(detail.includes('data-alibaba-unavailable'));
  assert.ok(!detail.includes('$18.90'));
});

// --- link removed: legacy restored -------------------------------------------

test('MATRIX link-removed: clearing the source key restores the legacy renderer exactly', () => {
  const restored = createAlibabaLinkedProduct({ moq: 1000, unitPrice: 18.9 });
  restored.alibabaPrimarySourceKey = undefined as unknown as string;
  const card = renderCard(restored);
  assert.ok(card.includes('data-product-card-price'));
  assert.ok(card.includes('$18.90'));
});
