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
  beginNumberedPage,
  failNumberedPage,
  initialNumberedCatalogState,
  receiveNumberedPage,
} from './numbered-catalog-state.ts';

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

const firstQuery = { page: 1, search: '', categories: null };

const readyState = () => ({ ...initialNumberedCatalogState(), committed: firstQuery });

const renderGrid = (state: ReturnType<typeof initialNumberedCatalogState>) =>
  renderToStaticMarkup(
    createElement(CatalogFamilyGrid, {
      content,
      family,
      state,
      selectedCategories: ['wired'],
      searchInput: '',
      onCategoriesChange: () => undefined,
      onSearchInputChange: () => undefined,
      onRetry: () => undefined,
      onOpenProduct: () => undefined,
      onPageChange: () => undefined,
    }),
  );

test('family catalog replaces twelve-card pages and rejects stale responses', () => {
  const initial = beginNumberedPage(initialNumberedCatalogState(), firstQuery);
  const first = receiveNumberedPage(
    initial,
    initial.generation,
    {
      items: Array.from({ length: 12 }, (_, index) => ({ _id: `first-${index}`, name: 'First' })),
      total: 25,
      page: 1,
      pageSize: 12,
    },
    'Load failed',
  );
  const loading = beginNumberedPage(first, { ...firstQuery, page: 2 });
  const secondItems = Array.from({ length: 12 }, (_, index) => ({
    _id: `second-${index}`,
    name: 'Second',
  }));
  const committed = receiveNumberedPage(
    loading,
    loading.generation,
    {
      items: secondItems,
      total: 25,
      page: 2,
      pageSize: 12,
    },
    'Load failed',
  );
  assert.deepEqual(committed.products, secondItems);
  assert.equal(committed.committed?.page, 2);
  assert.match(renderGrid(committed), /13\u201324 of 25 products/);
  assert.equal(
    receiveNumberedPage(
      loading,
      loading.generation - 1,
      {
        items: [{ _id: 'stale', name: 'Stale', slug: 'stale' }],
        total: 25,
        page: 2,
        pageSize: 12,
      },
      'Load failed',
    ),
    loading,
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
          schemaVersion: 'alibaba-catalog-pricing-v1',
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
    '$99.00',
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
  assert.match(source, /beginNumberedPage/);
  assert.match(source, /selectedCategories/);
  assert.match(source, /search/);
  assert.match(source, /parseCatalogQuery/);
  assert.match(source, /receiveNumberedPage/);
});

test('family grid renders mutually exclusive loading, error, empty, and success states', () => {
  const loading = renderGrid({ ...initialNumberedCatalogState(), pending: true });
  assert.match(loading, /Loading products/);
  assert.match(loading, /animate-pulse/);
  assert.doesNotMatch(loading, /role="alert"|\/products\/item/);

  const error = renderGrid({
    ...initialNumberedCatalogState(),
    error: 'Load failed',
  });
  assert.match(error, /role="alert"/);
  assert.match(error, /Try Again/);
  assert.doesNotMatch(error, /animate-pulse|\/products\/item/);

  const empty = renderGrid({ ...readyState(), total: 0 });
  assert.match(empty, /No products/);
  assert.doesNotMatch(empty, /animate-pulse|role="alert"|\/products\/item/);

  const success = renderGrid({
    ...readyState(),
    total: 1,
    products: [{ _id: 'valid', name: 'Valid', slug: ' valid ', images: [] }],
  });
  // The card expands the detail band on the same page, keyed by product id, so it
  // works for every published product rather than only slugged ones.
  assert.match(success, /<button[^>]+data-product-card="valid"/);
  assert.match(success, /data-product-card-action/);
  assert.match(success, /data-product-media="fallback"/);
  assert.doesNotMatch(success, /animate-pulse|role="alert"/);
});

test('family grid shows every published product, including rows without a slug', () => {
  const markup = renderGrid({
    ...readyState(),
    total: 25,
    products: [
      { _id: 'blank-slug', name: 'Blank Slug Product', slug: '   ' },
      { _id: 'legacy', name: 'Legacy Product Without Slug' },
    ],
  });
  // Legacy catalog rows predate slugs. They are still published, sellable products,
  // and the in-page detail band is keyed by id, so they are fully usable.
  assert.match(markup, /Blank Slug Product/);
  assert.match(markup, /Legacy Product Without Slug/);
  assert.match(markup, /data-product-card="legacy"/);
  assert.doesNotMatch(markup, /No products/);
  assert.match(markup, /aria-label="Pagination"/);
  assert.match(markup, /aria-label="Page 3"/);
  assert.doesNotMatch(markup, /Load More/);
});

test('pending pagination disables every page control and failure preserves clickable cards and retry', () => {
  const current = { ...readyState(), products: [{ _id: 'retained', name: 'Retained' }], total: 25 };
  const pending = beginNumberedPage(current, { ...firstQuery, page: 2 });
  const markup = renderGrid(pending);
  const pagination = markup.match(/<nav aria-label="Pagination"[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.equal((pagination.match(/<button/g) ?? []).length, 5);
  assert.equal((pagination.match(/disabled=""/g) ?? []).length, 5);
  const failed = renderGrid(failNumberedPage(pending, pending.generation, 'Load failed'));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Try Again/);
  assert.match(failed, /data-product-card="retained"/);
  assert.doesNotMatch(failed, /animate-pulse/);
});

test('family grid source keeps public card fields and excludes VIP and video', () => {
  const source = parse('./CatalogFamilyGrid.tsx');
  assert.match(source, /data-product-card=\{product\._id\}/);
  assert.match(source, /onOpenProduct\(product\._id\)/);
  assert.match(source, /ProductMedia/);
  assert.match(source, /effectiveCatalogPriceSummary/);
  assert.match(source, /quote/iu);
  assert.match(source, /loadingInitial/);
  assert.match(source, /state\.pending/);
  assert.match(source, /state\.error/);
  assert.match(source, /CatalogPagination/);
  assert.match(source, /categories\.length\s*>\s*0/);
  assert.doesNotMatch(source, /vipPrice|VIP|video/iu);
  assert.doesNotMatch(
    source,
    /href=\{`\/products\/item\/\?slug=\$\{encodeURIComponent\(product\.slug\s*\?\?/u,
  );
});
