import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import {
  CatalogFamilyGrid,
  catalogProductPrice,
  hasUsableCatalogSlug,
} from './CatalogFamilyGrid.tsx';
import {
  beginInitialLoad,
  beginLoadMore,
  commitCatalogPage,
  initialHeadphonesCatalogState,
  resetCatalogGeneration,
} from './headphonesCatalogState.ts';

const read = (fileName: string) =>
  readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), 'utf8');

const parse = (fileName: string) => {
  const source = read(fileName);
  const result = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics ?? [], [], `${fileName} parses`);
  return source;
};

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

const content = {
  list: {
    filterLabel: 'Categories',
    searchPlaceholder: 'Search products',
    loadingLabel: 'Loading products',
    errorLabel: 'Load failed',
    retryLabel: 'Try Again',
    emptyLabel: 'No products',
    resultsLabel: 'products',
    moqLabel: 'MOQ',
    loadMoreLabel: 'Load More',
  },
  detail: { inquiryCta: 'Request a Quote' },
} as CatalogContent;

const renderGrid = (state: ReturnType<typeof initialHeadphonesCatalogState>) =>
  renderToStaticMarkup(
    createElement(CatalogFamilyGrid, {
      content,
      family,
      state,
      selectedCategories: ['wired'],
      searchInput: '',
      onCategoriesChange: () => undefined,
      onSearchInputChange: () => undefined,
      onRetryInitial: () => undefined,
      onLoadMore: () => undefined,
    }),
  );

test('family catalog reuses generation guards and first-seen page dedupe', () => {
  const initial = beginInitialLoad(resetCatalogGeneration(initialHeadphonesCatalogState()));
  const first = commitCatalogPage(initial, initial.generation, {
    items: [
      { _id: 'a', name: 'A', slug: 'a' },
      { _id: 'b', name: 'B', slug: 'b' },
    ],
    total: 3,
    page: 1,
    pageSize: 2,
  });
  const loadingMore = beginLoadMore(first);
  const committed = commitCatalogPage(loadingMore, loadingMore.generation, {
    items: [
      { _id: 'b', name: 'B', slug: 'b' },
      { _id: 'c', name: 'C', slug: 'c' },
    ],
    total: 3,
    page: 2,
    pageSize: 2,
  });
  assert.deepEqual(
    committed.products.map((product) => product._id),
    ['a', 'b', 'c'],
  );
  assert.equal(
    commitCatalogPage(loadingMore, loadingMore.generation - 1, {
      items: [{ _id: 'stale', name: 'Stale', slug: 'stale' }],
      total: 4,
      page: 2,
      pageSize: 2,
    }),
    loadingMore,
  );
});

test('family cards choose source, public, or quote pricing and require usable slugs', () => {
  assert.equal(
    catalogProductPrice(
      {
        _id: 'linked',
        name: 'Linked',
        alibabaPrimarySourceKey: 'source-1',
        alibabaCatalogPricing: {
          schemaVersion: '1',
          source: 'alibaba',
          mode: 'fixed',
          currency: 'USD',
          amountMinor: 250,
          syncedAt: '2026-08-20T00:00:00.000Z',
        },
        wholesalePrice: 99,
      },
      'Request a Quote',
    ),
    '$2.50',
  );
  assert.equal(
    catalogProductPrice(
      { _id: 'public', name: 'Public', wholesalePrice: 8, unitPrice: 10 },
      'Request a Quote',
    ),
    '$8.00',
  );
  assert.equal(
    catalogProductPrice({ _id: 'unit', name: 'Unit', unitPrice: 10 }, 'Request a Quote'),
    '$10.00',
  );
  assert.equal(
    catalogProductPrice({ _id: 'quote', name: 'Quote' }, 'Request a Quote'),
    'Request a Quote',
  );
  assert.equal(hasUsableCatalogSlug({ _id: 'valid', name: 'Valid', slug: ' valid ' }), true);
  assert.equal(hasUsableCatalogSlug({ _id: 'blank', name: 'Blank', slug: '   ' }), false);
  assert.equal(hasUsableCatalogSlug({ _id: 'missing', name: 'Missing' }), false);
});

test('family controller owns family/filter/search generation resets and abortable fetches', () => {
  const source = parse('./CatalogFamilyPage.tsx');
  assert.match(source, /fetchCatalog\(\s*'\/api\/products',\s*\{[\s\S]*productFamily/);
  assert.match(source, /AbortController/);
  assert.match(source, /resetCatalogGeneration/);
  assert.match(source, /selectedCategories/);
  assert.match(source, /search/);
  assert.match(source, /beginLoadMore/);
  assert.match(source, /commitCatalogPage/);
});

test('family grid renders mutually exclusive loading, error, empty, and success states', () => {
  const loading = renderGrid({ ...initialHeadphonesCatalogState(), status: 'loading-initial' });
  assert.match(loading, /Loading products/);
  assert.match(loading, /animate-pulse/);
  assert.doesNotMatch(loading, /role="alert"|\/products\/item/);

  const error = renderGrid({
    ...initialHeadphonesCatalogState(),
    status: 'initial-error',
    initialError: 'Load failed',
  });
  assert.match(error, /role="alert"/);
  assert.match(error, /Try Again/);
  assert.doesNotMatch(error, /animate-pulse|\/products\/item/);

  const empty = renderGrid({ ...initialHeadphonesCatalogState(), status: 'ready', total: 0 });
  assert.match(empty, /No products/);
  assert.doesNotMatch(empty, /animate-pulse|role="alert"|\/products\/item/);

  const success = renderGrid({
    ...initialHeadphonesCatalogState(),
    status: 'ready',
    total: 1,
    nextPage: 2,
    products: [{ _id: 'valid', name: 'Valid', slug: ' valid ', images: [] }],
  });
  assert.match(success, /href="\/products\/item\/\?slug=valid"/);
  assert.match(success, /data-product-media="fallback"/);
  assert.doesNotMatch(success, /animate-pulse|role="alert"/);
});

test('family grid keeps pagination reachable when the current page has only invalid slugs', () => {
  const markup = renderGrid({
    ...initialHeadphonesCatalogState(),
    status: 'ready',
    total: 2,
    nextPage: 2,
    products: [{ _id: 'invalid', name: 'Invalid', slug: '   ' }],
  });
  assert.match(markup, /No products/);
  assert.match(markup, /Load More/);
  assert.doesNotMatch(markup, /\/products\/item/);
});

test('family grid source keeps public card fields and excludes VIP and video', () => {
  const source = parse('./CatalogFamilyGrid.tsx');
  assert.match(source, /\/products\/item\/\?slug=/);
  assert.match(source, /ProductMedia/);
  assert.match(source, /alibabaPriceSummary/);
  assert.match(source, /wholesalePrice\s*\?\?/);
  assert.match(source, /quote/iu);
  assert.match(source, /initial-error/);
  assert.match(source, /loading-initial/);
  assert.match(source, /loading-more/);
  assert.match(source, /loadMoreError/);
  assert.match(source, /categories\.length\s*>\s*0/);
  assert.doesNotMatch(source, /vipPrice|VIP|video/iu);
  assert.doesNotMatch(
    source,
    /href=\{`\/products\/item\/\?slug=\$\{encodeURIComponent\(product\.slug\s*\?\?/u,
  );
});
