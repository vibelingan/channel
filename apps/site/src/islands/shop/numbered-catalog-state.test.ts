import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import { CatalogFamilyGrid } from './CatalogFamilyGrid.tsx';
import type { CatalogPage, Product } from './catalog-types.ts';
import {
  type NumberedCatalogQuery,
  type NumberedCatalogState,
  beginNumberedPage,
  cancelNumberedPage,
  catalogPageNumbers,
  catalogQueryEquals,
  catalogQueryWithFilters,
  catalogUrl,
  failNumberedPage,
  initialNumberedCatalogState,
  parseCatalogQuery,
  receiveNumberedPage,
} from './numbered-catalog-state.ts';
import { sharedDetailSearch, sharedListSearch } from './shared-detail-navigation.ts';

const product = (overrides: Partial<Product> = {}): Product => ({
  _id: 'product-1',
  name: 'Product 1',
  ...overrides,
});

const family: CatalogFamilyContent = {
  key: 'headphones',
  label: 'Headphones',
  href: '/headphones/',
  eyebrow: 'Audio',
  heading: 'Headphones',
  description: 'Audio products',
  seoTitle: 'Headphones',
  seoDescription: 'Headphones for OEM programs.',
  image: '/media/section-capabilities.png',
  imageAlt: 'Audio products',
  imageWidth: 1448,
  imageHeight: 1086,
  categories: [{ key: 'wired', label: 'Wired' }],
};

const content: CatalogContent = {
  locale: 'en-US',
  menu: { label: 'Products', allLabel: 'All products' },
  hub: {
    eyebrow: 'Products',
    heading: 'Products',
    body: 'Products',
    seoTitle: 'Products',
    seoDescription: 'Products',
    quoteLabel: 'Quote',
    catalogLabel: 'Catalog',
    browseLabel: 'Browse',
    featuredHeading: 'Featured',
    emptyLabel: 'No products',
  },
  list: {
    filterLabel: 'Categories',
    allLabel: 'All products',
    searchPlaceholder: 'Search products',
    loadingLabel: 'Loading products',
    errorLabel: 'Load failed',
    retryLabel: 'Try Again',
    emptyLabel: 'No products',
    resultsLabel: 'products',
    moqLabel: 'MOQ',
    loadMoreLabel: 'Load More',
    wholesaleLabel: 'Wholesale',
    viewDetail: 'View details',
  },
  detail: {
    backLabel: 'Back',
    backToModelsLabel: 'Back to models',
    seriesLabel: 'Series',
    modelLabel: 'Model',
    typeLabel: 'Type',
    moqLabel: 'MOQ',
    unitPriceLabel: 'Unit price',
    wholesaleLabel: 'Wholesale',
    inquiryCta: 'Request a Quote',
    oemInquiryCta: 'OEM inquiry',
    viewAllLabel: 'View all',
    showLessLabel: 'Show less',
    imageUnavailableLabel: 'No image',
    oemEyebrow: 'OEM',
    oemHeading: 'OEM',
    oemBody: 'OEM',
    relatedHeading: 'Related',
    notFound: 'Not found',
  },
  families: [family],
};

const query = (overrides: Partial<NumberedCatalogQuery> = {}): NumberedCatalogQuery => ({
  page: 1,
  search: '',
  categories: null,
  ...overrides,
});

const page = (overrides: Partial<CatalogPage> = {}): CatalogPage => ({
  page: 1,
  pageSize: 12,
  total: 25,
  items: Array.from({ length: 12 }, (_, index) => product({ _id: `item-${index}` })),
  ...overrides,
});

const ready = () => {
  const pending = beginNumberedPage(initialNumberedCatalogState(), query());
  return receiveNumberedPage(pending, pending.generation, page(), 'Load failed');
};

const renderGrid = (
  state: NumberedCatalogState = ready(),
  overrides: Partial<CatalogFamilyContent> = {},
) =>
  renderToStaticMarkup(
    createElement(CatalogFamilyGrid, {
      content,
      family: { ...family, ...overrides },
      state,
      selectedCategories: ['wired'],
      searchInput: '',
      onCategoriesChange: () => undefined,
      onSearchInputChange: () => undefined,
      onRetry: () => undefined,
      onPageChange: () => undefined,
      onOpenProduct: () => undefined,
    }),
  );

test('25 products render numbered pages instead of Load More', () => {
  const markup = renderGrid();
  assert.match(markup, /aria-current="page"/);
  assert.match(markup, /aria-label="Page 3"/);
  assert.doesNotMatch(markup, /data-load-more|Load More/);
});

test('the catalog announces the current product range and server total', () => {
  assert.match(renderGrid(), /1(?:–|&#x2013;|&ndash;)12 of 25 products/);
});

test('URL contract: page 2 deep links include search and category', () => {
  assert.deepEqual(
    parseCatalogQuery('?page=2&search= usb &category=wired', ['wired', 'tws']),
    query({ page: 2, search: 'usb', categories: ['wired'] }),
  );
});

test('URL contract: malformed and duplicate pages normalize to page 1', () => {
  for (const search of [
    '?page=0',
    '?page=-1',
    '?page=1.5',
    '?page=NaN',
    '?page=1e2',
    '?page=',
    '?page=9007199254740992',
    '?page=2&page=3',
    '?page=02',
  ]) {
    const parsed = parseCatalogQuery(search, []);
    assert.equal(parsed.page, 1, search);
    const normalized = new URL(
      catalogUrl(`https://example.test/headphones/${search}`, parsed),
      'https://example.test',
    );
    assert.deepEqual(normalized.searchParams.getAll('page'), ['1']);
  }
});

test('URL contract: all, none, unknown, mixed and duplicate categories never broaden', () => {
  const keys = ['wired', 'tws'];
  assert.equal(parseCatalogQuery('', keys).categories, null);
  assert.equal(parseCatalogQuery('?category=tws,wired', keys).categories, null);
  for (const search of [
    '?category=__none__',
    '?category=',
    '?category=unknown',
    '?category=wired,unknown',
    '?category=wired&category=tws',
  ]) {
    const parsed = parseCatalogQuery(search, keys);
    assert.deepEqual(parsed.categories, [], search);
    assert.match(catalogUrl('https://example.test/headphones/', parsed), /category=__none__/);
  }
  assert.deepEqual(parseCatalogQuery('?category=wired,wired', keys).categories, ['wired']);
  assert.deepEqual(parseCatalogQuery('?category=wired', []).categories, []);
});

test('URL contract: serialization preserves unrelated query values, detail and hash', () => {
  const href = catalogUrl(
    'https://example.test/headphones/?page=8&page=9&search=old&category=tws&id=p1&variant=v1&preview=shared&tag=a&tag=b#catalog',
    query({ page: 2, search: 'a & b', categories: ['wired'] }),
  );
  const parsed = new URL(href, 'https://example.test');
  assert.equal(parsed.pathname, '/headphones/');
  assert.equal(parsed.hash, '#catalog');
  assert.deepEqual(parsed.searchParams.getAll('page'), ['2']);
  assert.equal(parsed.searchParams.get('id'), 'p1');
  assert.equal(parsed.searchParams.get('variant'), 'v1');
  assert.equal(parsed.searchParams.get('preview'), 'shared');
  assert.deepEqual(parsed.searchParams.getAll('tag'), ['a', 'b']);
  assert.deepEqual(
    parseCatalogQuery(parsed.search, ['wired', 'tws']),
    query({ page: 2, search: 'a & b', categories: ['wired'] }),
  );
});

test('URL contract: duplicate search normalizes deterministically and defaults remove filters', () => {
  const parsed = parseCatalogQuery('?search= usb &search=ignored', []);
  const href = catalogUrl('https://example.test/?search=old&search=older&category=wired', parsed);
  const params = new URL(href, 'https://example.test').searchParams;
  assert.deepEqual(params.getAll('search'), ['usb']);
  assert.equal(params.has('category'), false);
});

test('URL contract: shared detail open and Back preserve the committed list query', () => {
  const search = '?preview=shared&page=2&search=usb&category=wired&campaign=spring';
  const detail = sharedDetailSearch(search, 'product-1');
  assert.ok(detail);
  assert.equal(
    catalogQueryEquals(
      parseCatalogQuery(detail, ['wired', 'tws']),
      parseCatalogQuery(search, ['wired', 'tws']),
    ),
    true,
  );
  assert.equal(sharedListSearch(detail), search);
});

test('filters reset page to 1 and canonicalize all and none distinctly', () => {
  const current = query({ page: 3 });
  assert.deepEqual(
    catalogQueryWithFilters(current, ' usb ', ['tws'], ['wired', 'tws']),
    query({ search: 'usb', categories: ['tws'] }),
  );
  assert.deepEqual(catalogQueryWithFilters(current, '', [], ['wired']), query({ categories: [] }));
  assert.equal(catalogQueryWithFilters(current, '', ['wired'], ['wired']).categories, null);
  assert.equal(catalogQueryWithFilters(current, '', [], []).categories, null);
});

test('filters without category checkboxes retain explicit none when search changes', () => {
  for (const search of ['?category=__none__', '?category=unknown']) {
    const current = parseCatalogQuery(search, []);
    assert.deepEqual(catalogQueryWithFilters(current, 'usb', [], []).categories, []);
  }
});

test('state: initial shell is stable and a deep link requests page 2 directly', () => {
  const initial = initialNumberedCatalogState();
  assert.equal(initial.committed, null);
  assert.deepEqual(initial.products, []);
  const pending = beginNumberedPage(initial, query({ page: 2 }));
  assert.equal(pending.requested.page, 2);
  assert.equal(pending.committed, null);
  const result = receiveNumberedPage(pending, pending.generation, page({ page: 2 }), 'failed');
  assert.equal(result.committed?.page, 2);
});

test('state: success replaces the previous 12 cards instead of appending', () => {
  const first = ready();
  const pending = beginNumberedPage(first, query({ page: 2 }));
  assert.equal(pending.products, first.products);
  assert.equal(pending.committed?.page, 1);
  const items = Array.from({ length: 12 }, (_, index) => product({ _id: `second-${index}` }));
  const result = receiveNumberedPage(
    pending,
    pending.generation,
    page({ page: 2, items }),
    'failed',
  );
  assert.deepEqual(result.products, items);
  assert.equal(result.products.length, 12);
  assert.equal(result.committed?.page, 2);
  assert.equal(result.pending, false);
});

test('state: initial failure blocks and retry keeps the failed deep link target', () => {
  const pending = beginNumberedPage(initialNumberedCatalogState(), query({ page: 2 }));
  const failed = failNumberedPage(pending, pending.generation, 'failed');
  assert.equal(failed.committed, null);
  assert.equal(failed.error, 'failed');
  const retry = beginNumberedPage(failed, failed.requested);
  assert.equal(retry.requested.page, 2);
  assert.equal(retry.error, null);
  assert.ok(retry.generation > failed.generation);
});

test('state: later failures retain cards, total and committed query; retry targets failed filters', () => {
  const first = ready();
  const target = query({ search: 'usb', categories: ['wired'] });
  const pending = beginNumberedPage(first, target);
  const failed = failNumberedPage(pending, pending.generation, 'failed');
  assert.equal(failed.products, first.products);
  assert.equal(failed.total, first.total);
  assert.equal(failed.committed, first.committed);
  assert.deepEqual(beginNumberedPage(failed, failed.requested).requested, target);
});

test('state: stale A-B-A success AND failure cannot overwrite the newest identical query', () => {
  const firstA = beginNumberedPage(ready(), query());
  const secondB = beginNumberedPage(firstA, query({ page: 2 }));
  const latestA = beginNumberedPage(secondB, query());
  assert.equal(receiveNumberedPage(latestA, firstA.generation, page(), 'failed'), latestA);
  assert.equal(failNumberedPage(latestA, firstA.generation, 'stale'), latestA);
  assert.equal(
    receiveNumberedPage(latestA, secondB.generation, page({ page: 2 }), 'failed'),
    latestA,
  );
  assert.equal(failNumberedPage(latestA, secondB.generation, 'stale'), latestA);
});

test('state: cancellation invalidates even an uncooperative response and restores committed query', () => {
  const pending = beginNumberedPage(ready(), query({ page: 2 }));
  const cancelled = cancelNumberedPage(pending);
  assert.equal(cancelled.pending, false);
  assert.equal(cancelled.requested, cancelled.committed);
  assert.equal(
    receiveNumberedPage(cancelled, pending.generation, page({ page: 2 }), 'failed'),
    cancelled,
  );
  assert.equal(failNumberedPage(cancelled, pending.generation, 'stale'), cancelled);
});

test('state: matching detail history reuses only a live request, never one aborted by cleanup', async () => {
  const { catalogRequestIsPending } = await import('./numbered-catalog-state.ts');
  const target = query({ page: 2 });
  const pending = beginNumberedPage(initialNumberedCatalogState(), target);
  assert.equal(catalogRequestIsPending(pending, target, false), true);
  assert.equal(catalogRequestIsPending(pending, target, true), false);
  assert.equal(catalogRequestIsPending(pending, query(), false), false);
  assert.equal(catalogRequestIsPending(cancelNumberedPage(pending), target, false), false);
});

test('state: wrong page, pageSize, oversized pages and invalid totals fail without replacing cards', () => {
  for (const response of [
    page({ page: 3 }),
    page({ pageSize: 24 }),
    page({ total: -1 }),
    page({ total: 1.5 }),
    page({ total: 2 }),
    page({ items: Array.from({ length: 13 }, () => product()) }),
  ]) {
    const pending = beginNumberedPage(ready(), query());
    const failed = receiveNumberedPage(pending, pending.generation, response, 'invalid');
    assert.equal(failed.error, 'invalid');
    assert.equal(failed.pending, false);
    assert.equal(failed.products, pending.products);
  }
});

test('state: unpublish recovers to the last page once and commits only the recovered result', () => {
  const pending = beginNumberedPage(ready(), query({ page: 3 }));
  const recovering = receiveNumberedPage(
    pending,
    pending.generation,
    page({ page: 3, total: 13, items: [] }),
    'failed',
  );
  assert.equal(recovering.pending, true);
  assert.equal(recovering.requested.page, 2);
  assert.equal(recovering.committed?.page, 1);
  const result = receiveNumberedPage(
    recovering,
    recovering.generation,
    page({ page: 2, total: 13, items: [product({ _id: 'last' })] }),
    'failed',
  );
  assert.equal(result.committed?.page, 2);
  assert.equal(result.products.length, 1);
  assert.equal(result.total, 13);
});

test('state: a second unpublish during recovery fails instead of looping', () => {
  const pending = beginNumberedPage(ready(), query({ page: 3 }));
  const recovering = receiveNumberedPage(
    pending,
    pending.generation,
    page({ page: 3, total: 13, items: [] }),
    'failed',
  );
  const failed = receiveNumberedPage(
    recovering,
    recovering.generation,
    page({ page: 2, total: 0, items: [] }),
    'failed',
  );
  assert.equal(failed.pending, false);
  assert.equal(failed.error, 'failed');
  assert.equal(failed.committed?.page, 1);
});

test('state: zero products recovers to page 1 without a phantom page', () => {
  const pending = beginNumberedPage(initialNumberedCatalogState(), query({ page: 2 }));
  const recovering = receiveNumberedPage(
    pending,
    pending.generation,
    page({ page: 2, total: 0, items: [] }),
    'failed',
  );
  const result = receiveNumberedPage(
    recovering,
    recovering.generation,
    page({ total: 0, items: [] }),
    'failed',
  );
  assert.equal(result.committed?.page, 1);
  assert.equal(result.total, 0);
  assert.equal(result.error, null);
});

test('state: a response after settlement cannot mutate a ready page', () => {
  const current = ready();
  assert.equal(
    receiveNumberedPage(current, current.generation, page({ total: 99 }), 'failed'),
    current,
  );
  assert.equal(failNumberedPage(current, current.generation, 'late'), current);
});

test('page numbers stay bounded for 0, 1, 12, 13, 25 and very large catalogs', () => {
  for (const total of [0, 1, 12]) assert.deepEqual(catalogPageNumbers(1, total), [1]);
  assert.deepEqual(catalogPageNumbers(1, 13), [1, 2]);
  assert.deepEqual(catalogPageNumbers(3, 25), [1, 2, 3]);
  assert.deepEqual(catalogPageNumbers(500, 12000), [1, 499, 500, 501, 1000]);
});

test('pagination controls stay on committed page and are disabled during requests', () => {
  const markup = renderGrid(beginNumberedPage(ready(), query({ page: 2 })));
  const navigation = markup.match(/<nav[\s\S]*?<\/nav>/)?.[0];
  assert.ok(navigation);
  assert.match(navigation, /aria-label="Page 1"[^>]*aria-current="page"/);
  for (const button of navigation.matchAll(/<button[^>]*>/g))
    assert.match(button[0], /disabled=""/);
  assert.equal((markup.match(/data-product-card="/g) ?? []).length, 12);
});

test('initial failure is blocking, later failure preserves cards and offers retry', () => {
  const initial = beginNumberedPage(initialNumberedCatalogState(), query());
  const blocked = renderGrid(failNumberedPage(initial, initial.generation, 'Load failed'));
  assert.match(blocked, /role="alert"/);
  assert.match(blocked, /Try Again/);
  assert.doesNotMatch(blocked, /data-product-card="|<nav/);
  const pending = beginNumberedPage(ready(), query({ page: 2 }));
  const recoverable = renderGrid(failNumberedPage(pending, pending.generation, 'Load failed'));
  assert.match(recoverable, /role="alert"/);
  assert.match(recoverable, /Try Again/);
  assert.equal((recoverable.match(/data-product-card="/g) ?? []).length, 12);
});

test('all four families render the same 12-card numbered grid', () => {
  const keys: CatalogFamilyContent['key'][] = ['headphones', 'ai-gadgets', 'toys', 'misc'];
  for (const key of keys) {
    const markup = renderGrid(ready(), {
      key,
      categories: key === 'headphones' ? family.categories : [],
    });
    assert.equal((markup.match(/data-product-card="/g) ?? []).length, 12, key);
    assert.match(markup, /aria-label="Page 3"/);
    assert.doesNotMatch(markup, /data-load-more/);
  }
});

test('0, 1, 12, 13 and 25 product totals render exact card counts and page boundaries', () => {
  for (const total of [0, 1, 12, 13, 25]) {
    const pending = beginNumberedPage(initialNumberedCatalogState(), query());
    const current = receiveNumberedPage(
      pending,
      pending.generation,
      page({
        total,
        items: page().items.slice(0, Math.min(12, total)),
      }),
      'failed',
    );
    const markup = renderGrid(current);
    assert.equal((markup.match(/data-product-card="/g) ?? []).length, Math.min(12, total));
    assert.ok(markup.includes(`of ${total} products`));
    if (total === 0) {
      assert.match(markup, /No products/);
      assert.doesNotMatch(markup, /<nav/);
    } else {
      const next = markup.match(/<button[^>]*aria-label="Next page"[^>]*>/)?.[0];
      assert.ok(next);
      assert.equal(next.includes('disabled=""'), total <= 12);
    }
  }
});

test('the last page shows 25 through 25 with Next disabled', () => {
  const pending = beginNumberedPage(ready(), query({ page: 3 }));
  const last = receiveNumberedPage(
    pending,
    pending.generation,
    page({ page: 3, items: [product({ _id: 'last' })] }),
    'failed',
  );
  const markup = renderGrid(last);
  assert.match(markup, /25(?:–|&#x2013;|&ndash;)25 of 25 products/);
  assert.match(markup, /aria-label="Next page"[^>]*disabled=""/);
  assert.match(markup, /aria-label="Page 3"[^>]*aria-current="page"/);
});
