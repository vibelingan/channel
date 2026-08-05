import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';
import { HeadphonesCatalog, formatResultProgress } from './HeadphonesCatalog.tsx';
import { HeadphonesProductCard } from './HeadphonesProductCard.tsx';
import type { Product } from './catalog-types.ts';
import {
  type HeadphonesCatalogState,
  beginInitialLoad,
  beginLoadMore,
  commitCatalogPage,
  failInitialLoad,
  failLoadMore,
  initialHeadphonesCatalogState,
} from './headphonesCatalogState.ts';

/** Complete list-content fixture typed against the real contract. */
const LIST: HeadphonesContent['list'] = {
  eyebrow: 'Catalog',
  heading: 'Headphones',
  subheading: 'Programs',
  filterLabel: 'Filter',
  allLabel: 'All',
  resultsLabel: 'results',
  loadingLabel: 'Loading products…',
  errorLabel: 'The catalog failed to load.',
  retryLabel: 'Retry',
  emptyLabel: 'No products published yet.',
  emptyStateLabel: 'No models are published right now.',
  emptyCtaLabel: 'Start an OEM enquiry',
  loadMoreLabel: 'Load more models',
  loadingMoreLabel: 'Loading more…',
  resultProgressLabel: '{loaded} of {total} models',
  categories: [
    { key: 'wired', label: 'Wired' },
    { key: 'tws', label: 'True Wireless' },
  ],
  wholesaleLabel: 'Wholesale',
  vipLabel: 'VIP',
  vipLockedLabel: 'Sign in for VIP pricing',
  viewDetail: 'View details',
  moqLabel: 'MOQ',
};

const IMAGE_UNAVAILABLE = 'Image unavailable';

function product(id: string, over: Partial<Product> = {}): Product {
  return {
    _id: id,
    name: `Model ${id}`,
    category: 'wired',
    unitPrice: 12.5,
    moq: 500,
    images: [`https://media.example.test/${id}.jpg`],
    ...over,
  };
}

function readyState(products: Product[], total: number): HeadphonesCatalogState {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  return commitCatalogPage(state, state.generation, {
    items: products,
    total,
    page: 1,
    pageSize: Math.max(products.length, 1),
  });
}

function renderCatalog(state: HeadphonesCatalogState): string {
  return renderToStaticMarkup(
    createElement(HeadphonesCatalog, {
      list: LIST,
      imageUnavailableLabel: IMAGE_UNAVAILABLE,
      state,
      onRetryInitial: () => {},
      onLoadMore: () => {},
      onOpenProduct: () => {},
    }),
  );
}

// --- mutually exclusive async branches --------------------------------------

test('loading renders a polite status and no cards, error, or empty state', () => {
  const html = renderCatalog(beginInitialLoad(initialHeadphonesCatalogState()));
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes(LIST.loadingLabel));
  assert.ok(!html.includes('data-product-card'));
  assert.ok(!html.includes('role="alert"'));
  assert.ok(!html.includes(LIST.emptyStateLabel));
});

test('an initial error renders an alert with an actionable retry and nothing else', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = failInitialLoad(state, state.generation, 'network down');
  const html = renderCatalog(state);
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes('network down'));
  assert.ok(html.includes(LIST.retryLabel));
  assert.ok(!html.includes('data-product-card'));
  assert.ok(!html.includes(LIST.loadingLabel));
  assert.ok(!html.includes(LIST.emptyStateLabel));
});

test('an empty catalog renders the OEM-linked empty state and no cards', () => {
  const html = renderCatalog(readyState([], 0));
  assert.ok(html.includes(LIST.emptyStateLabel));
  assert.ok(html.includes(`href="${OEM_INQUIRY_HREF}"`));
  assert.ok(html.includes(LIST.emptyCtaLabel));
  assert.ok(!html.includes('data-product-card'));
  assert.ok(!html.includes('role="alert"'));
});

test('success groups cards under category headings from the content contract', () => {
  const html = renderCatalog(
    readyState(
      [product('w1'), product('t1', { category: 'tws' }), product('w2')],
      3,
    ),
  );
  assert.ok(html.includes('Wired'));
  assert.ok(html.includes('True Wireless'));
  assert.ok(html.indexOf('data-product-card="w1"') >= 0);
  assert.ok(html.indexOf('data-product-card="t1"') >= 0);
  assert.ok(html.indexOf('data-product-card="w2"') >= 0);
  // Grouping: both wired cards sit inside the Wired section, before the TWS heading? No —
  // groups follow first-seen category order: wired first, tws second.
  assert.ok(html.indexOf('Wired') < html.indexOf('True Wireless'));
});

// --- Load More contract -----------------------------------------------------

test('Load More appears only while loaded unique ids are below total', () => {
  const hasMore = renderCatalog(readyState([product('p1'), product('p2')], 5));
  assert.ok(hasMore.includes(LIST.loadMoreLabel));
  const complete = renderCatalog(readyState([product('p1'), product('p2')], 2));
  assert.ok(!complete.includes(LIST.loadMoreLabel));
  assert.ok(!complete.includes(LIST.loadingMoreLabel));
});

test('a busy Load More is disabled and announces its progress label', () => {
  const state = beginLoadMore(readyState([product('p1')], 3));
  const html = renderCatalog(state);
  assert.ok(html.includes(LIST.loadingMoreLabel));
  assert.ok(/data-load-more[^>]*disabled/.test(html));
});

test('a load-more failure keeps cards rendered with a recoverable alert', () => {
  let state = beginLoadMore(readyState([product('p1')], 3));
  state = failLoadMore(state, state.generation, 'page 2 failed');
  const html = renderCatalog(state);
  assert.ok(html.includes('data-product-card="p1"'));
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes('page 2 failed'));
  assert.ok(html.includes(LIST.loadMoreLabel));
});

test('duplicate product ids in the rendered list still produce one card', () => {
  const state = {
    ...readyState([product('p1')], 2),
    products: [product('p1'), product('p1')],
  };
  const html = renderCatalog(state);
  assert.equal(html.split('data-product-card="p1"').length - 1, 1);
});

// --- result progress --------------------------------------------------------

test('result progress substitutes loaded and total into the content template', () => {
  assert.equal(formatResultProgress('{loaded} of {total} models', 12, 60), '12 of 60 models');
  const html = renderCatalog(readyState([product('p1'), product('p2')], 6));
  assert.ok(html.includes('2 of 6 models'));
});

// --- card contract ----------------------------------------------------------

test('the card is a semantic in-page expansion button using ProductMedia', () => {
  const html = renderToStaticMarkup(
    createElement(HeadphonesProductCard, {
      product: product('p9'),
      list: LIST,
      imageUnavailableLabel: IMAGE_UNAVAILABLE,
      onOpen: () => {},
    }),
  );
  assert.ok(html.includes('data-product-card="p9"'));
  assert.ok(html.includes('type="button"'));
  assert.ok(html.includes('data-product-media='));
  assert.ok(!html.includes('<a '));
});

test('card hierarchy keeps identity strongest, price at 14px/600, action at 12px/500', () => {
  const html = renderToStaticMarkup(
    createElement(HeadphonesProductCard, {
      product: product('p9'),
      list: LIST,
      imageUnavailableLabel: IMAGE_UNAVAILABLE,
      onOpen: () => {},
    }),
  );
  assert.ok(/data-product-card-price[^>]*class="[^"]*text-sm font-semibold/.test(html));
  assert.ok(/data-product-card-action[^>]*class="[^"]*text-xs font-medium/.test(html));
  assert.ok(html.includes('$12.50'));
  assert.ok(html.includes(`${LIST.moqLabel}:`));
  assert.ok(html.includes(LIST.viewDetail));
});

test('a card without media renders the terminal fallback with reserved geometry', () => {
  const html = renderToStaticMarkup(
    createElement(HeadphonesProductCard, {
      product: product('bare', { images: [] }),
      list: LIST,
      imageUnavailableLabel: IMAGE_UNAVAILABLE,
      onOpen: () => {},
    }),
  );
  assert.ok(html.includes('data-product-media="fallback"'));
  assert.ok(html.includes(IMAGE_UNAVAILABLE));
  assert.ok(html.includes('aspect-square'));
});
