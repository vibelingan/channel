import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import { type ReactElement, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { HeadphonesProductCard } from '../../islands/shop/HeadphonesProductCard.tsx';
import { createProduct } from '../../test/factories/catalog.ts';
import { CatalogCard, type CatalogCardProps } from './CatalogCard.tsx';

const facts = {
  identifier: 'HP-100',
  moq: 100,
  moqLabel: 'MOQ',
  unavailableLabel: 'Pricing unavailable — request a quote',
  actionLabel: 'View details',
  imageUnavailableLabel: 'Image unavailable',
};

const product = {
  _id: 'legacy-id',
  name: 'A deliberately uneven and much longer product title',
  modName: 'HP-100',
  description: 'Two-line description.',
  images: [],
};

const list: HeadphonesContent['list'] = {
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
  viewDetail: 'View details',
  moqLabel: 'MOQ',
};

function render(
  pricing: CatalogPricingDecision,
  overrides: Partial<CatalogCardProps> = {},
): string {
  return renderToStaticMarkup(
    createElement(CatalogCard, {
      product,
      pricing,
      facts,
      onActivate: () => {},
      ...overrides,
    }),
  );
}

test('slugless oldest product activates by _id and emits no unusable link', () => {
  let activated = '';
  const element = CatalogCard({
    product,
    pricing: { source: 'quote-required' },
    facts,
    onActivate: (id) => {
      activated = id;
    },
  }) as ReactElement<{ onClick: () => void }>;
  element.props.onClick();
  assert.equal(activated, 'legacy-id');
  const html = render({ source: 'quote-required' });
  assert.match(html, /^<button/);
  assert.doesNotMatch(html, /<a |href=/);
});

test('addressable product emits its deep link and still activates by _id', () => {
  let activated = '';
  const element = CatalogCard({
    product,
    pricing: { source: 'quote-required' },
    facts,
    deepLink: '/products/item?slug=legacy-id',
    onActivate: (id) => {
      activated = id;
    },
  }) as ReactElement<{ href: string; onClick: () => void }>;
  element.props.onClick();
  assert.equal(activated, 'legacy-id');
  assert.equal(element.props.href, '/products/item?slug=legacy-id');
  assert.match(
    render({ source: 'quote-required' }, { deepLink: '/products/item?slug=legacy-id' }),
    /^<a href="\/products\/item\?slug=legacy-id"/,
  );
});

test('pricing, MOQ, action, and fixed card geometry cover every decision source', () => {
  const cases: Array<[CatalogPricingDecision, string]> = [
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'fixed',
          currency: 'USD',
          amountMinor: 250,
          sourceMoq: 50,
        },
      },
      '$2.50',
    ],
    [
      {
        source: 'manual-tiered',
        pricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 900 }],
        },
      },
      'From $9.00',
    ],
    [{ source: 'scalar', field: 'unitPrice', amount: 12.5, currency: 'USD' }, '$12.50'],
    [{ source: 'quote-required' }, facts.unavailableLabel],
  ];
  for (const [decision, expected] of cases) {
    const html = render(decision);
    assert.ok(html.includes(expected));
    assert.ok(html.includes('aspect-square'));
    assert.ok(html.includes('flex flex-1 flex-col'));
    assert.ok(html.includes('mt-auto'));
    assert.match(html, /data-catalog-card-price[^>]*text-sm font-semibold/);
    assert.match(html, /data-catalog-card-action[^>]*text-xs font-medium/);
  }
});

test('Alibaba range, tiered, quote, and unavailable decisions render without fallback', () => {
  const cases: Array<[CatalogPricingDecision, string, string]> = [
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'range',
          currency: 'USD',
          minAmountMinor: 250,
          maxAmountMinor: 499,
        },
      },
      '$2.50 – $4.99',
      'data-alibaba-card-price',
    ],
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'tiered',
          currency: 'USD',
          tiers: [
            { minQuantity: 1, maxQuantity: 99, unitAmountMinor: 350 },
            { minQuantity: 100, unitAmountMinor: 225 },
          ],
        },
      },
      'From $2.25',
      'data-alibaba-card-price',
    ],
    [
      {
        source: 'alibaba',
        pricing: { source: 'alibaba', state: 'quote', mode: 'negotiable' },
      },
      facts.unavailableLabel,
      'data-alibaba-card-unavailable',
    ],
    [
      {
        source: 'alibaba',
        pricing: { source: 'alibaba', state: 'unavailable', mode: 'unavailable' },
      },
      facts.unavailableLabel,
      'data-alibaba-card-unavailable',
    ],
  ];
  for (const [decision, expected, marker] of cases) {
    const html = render(decision, { facts: { ...facts, moq: undefined } });
    assert.ok(html.includes(expected));
    assert.ok(html.includes(marker));
    assert.ok(!html.includes('data-product-card-price'));
    assert.ok(!html.includes(`${facts.moqLabel}:`));
  }
});

test('Headphones rollback wrapper preserves legacy unit price when newer prices coexist', () => {
  const html = renderToStaticMarkup(
    createElement(HeadphonesProductCard, {
      product: createProduct({
        unitPrice: 18.9,
        wholesalePrice: 15.5,
        manualCatalogPricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 900 }],
        },
      }),
      list,
      imageUnavailableLabel: 'Image unavailable',
      onOpen: () => {},
    }),
  );
  assert.ok(html.includes('data-product-card-price'));
  assert.ok(html.includes('$18.90'));
  assert.ok(!html.includes('$15.50'));
  assert.ok(!html.includes('From $9.00'));
});

test('presentation source has no family or provider-field conditionals', () => {
  const source = readFileSync(fileURLToPath(new URL('./CatalogCard.tsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(
    source,
    /Headphones|productFamily|alibabaPrimarySourceKey|alibabaCatalogPricing/,
  );
});
