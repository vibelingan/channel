import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import { apiUrl } from '../../lib/api-url.ts';
import { CatalogFamilyPage } from './CatalogFamilyPage.tsx';
import { fetchCatalog } from './api.ts';
import {
  type PublicCatalogTaxonomy,
  decodeCatalogTaxonomy,
  fetchCatalogTaxonomy,
  parseTaxonomyCatalogQuery,
} from './catalog-taxonomy.ts';
import { catalogUrl } from './numbered-catalog-state.ts';

function taxonomy(overrides: Partial<PublicCatalogTaxonomy> = {}): PublicCatalogTaxonomy {
  return {
    family: 'headphones',
    name: 'Audio',
    revision: 3,
    children: [
      { id: 'headphones-wired', name: 'Wired', slug: 'wired', order: 2 },
      { id: 'headphones-office', name: 'Office', slug: 'office', order: 1 },
    ],
    ...overrides,
  };
}

test('public taxonomy decoder validates the exact projection and orders active children', () => {
  const decoded = decodeCatalogTaxonomy(taxonomy(), 'headphones');
  assert.deepEqual(
    decoded.children.map((child) => child.id),
    ['headphones-office', 'headphones-wired'],
  );
  const valid = taxonomy();
  for (const invalid of [
    null,
    [],
    { ...valid, family: 'toys' },
    { ...valid, revision: -1 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, name: ' ' },
    { ...valid, internal: true },
    { ...valid, children: [{ ...valid.children[0], status: 'active' }] },
    { ...valid, children: [{ ...valid.children[0], order: -1 }] },
    { ...valid, children: [{ ...valid.children[0], id: 'bad,id' }] },
    { ...valid, children: [{ ...valid.children[0], slug: '../bad' }] },
    { ...valid, children: [valid.children[0], valid.children[0]] },
    { ...valid, children: [{ ...valid.children[0], name: 'Office' }, valid.children[1]] },
  ]) {
    assert.throws(() => decodeCatalogTaxonomy(invalid, 'headphones'));
  }
});

test('all four families use stable IDs without broadening an explicit all-child selection', () => {
  for (const family of ['headphones', 'ai-gadgets', 'toys', 'misc'] as const) {
    const registry = taxonomy({
      family,
      children: [{ id: `${family}-child`, name: 'Child', slug: 'child', order: 0 }],
    });
    const query = parseTaxonomyCatalogQuery(
      `?category=${family}-child&page=2&search=audio`,
      registry,
    );
    assert.deepEqual(query, { page: 2, search: 'audio', categories: [`${family}-child`] });
    const url = catalogUrl(`https://example.test/${family}/`, query);
    assert.deepEqual(
      parseTaxonomyCatalogQuery(new URL(url, 'https://example.test').search, registry),
      query,
    );
  }
});

test('only known legacy headphones aliases map when no new query is present', () => {
  assert.deepEqual(parseTaxonomyCatalogQuery('?category=wired', taxonomy()).categories, [
    'headphones-wired',
  ]);
  assert.deepEqual(parseTaxonomyCatalogQuery('?category=wired,office', taxonomy()).categories, [
    'headphones-office',
    'headphones-wired',
  ]);
  assert.deepEqual(
    parseTaxonomyCatalogQuery('?subcategoryIds=headphones-office&category=wired', taxonomy())
      .categories,
    ['headphones-office'],
  );
  assert.throws(() =>
    parseTaxonomyCatalogQuery('?subcategoryIds=wired&category=wired', taxonomy()),
  );
  assert.throws(() => parseTaxonomyCatalogQuery('?category=wired', taxonomy({ family: 'toys' })));
  assert.throws(() => parseTaxonomyCatalogQuery('?category=bluetooth', taxonomy()));
});

test('stale, empty, repeated and malformed URL selections fail closed', () => {
  for (const search of [
    '?category=deleted',
    '?category=',
    '?category=headphones-wired,',
    '?category=headphones-wired&category=headphones-office',
    '?subcategoryIds=',
    '?subcategoryIds=headphones-wired&subcategoryIds=headphones-office',
    '?subcategoryIds=__none__',
  ])
    assert.throws(() => parseTaxonomyCatalogQuery(search, taxonomy()));
  assert.deepEqual(parseTaxonomyCatalogQuery('?category=__none__', taxonomy()).categories, []);
  assert.equal(parseTaxonomyCatalogQuery('', taxonomy({ children: [] })).categories, null);
  assert.throws(() =>
    parseTaxonomyCatalogQuery('?category=headphones-wired', taxonomy({ children: [] })),
  );
});

test('taxonomy outages allow unfiltered lists but never accept selected URL children', () => {
  assert.deepEqual(parseTaxonomyCatalogQuery('?search=audio&page=2', null), {
    page: 2,
    search: 'audio',
    categories: null,
  });
  for (const search of [
    '?category=wired',
    '?category=headphones-wired',
    '?subcategoryIds=headphones-wired',
    '?category=',
  ]) {
    assert.throws(() => parseTaxonomyCatalogQuery(search, null));
  }
  assert.deepEqual(parseTaxonomyCatalogQuery('?category=__none__', null).categories, []);
});

test('server rendering never presents legacy checkboxes before the public registry loads', () => {
  const content: CatalogContent = {
    locale: 'en',
    menu: { label: 'Catalog', allLabel: 'All' },
    hub: {
      eyebrow: '',
      heading: '',
      body: '',
      seoTitle: '',
      seoDescription: '',
      quoteLabel: '',
      catalogLabel: '',
      browseLabel: '',
      featuredHeading: '',
      emptyLabel: '',
    },
    list: {
      filterLabel: 'Categories',
      allLabel: 'All',
      resultsLabel: 'products',
      searchPlaceholder: 'Search',
      loadingLabel: 'Loading',
      errorLabel: 'Load failed',
      retryLabel: 'Retry',
      emptyLabel: 'No products',
      loadMoreLabel: 'Load More',
      wholesaleLabel: 'Wholesale',
      moqLabel: 'MOQ',
      viewDetail: 'Details',
    },
    detail: {
      backLabel: '',
      backToModelsLabel: '',
      seriesLabel: '',
      modelLabel: '',
      typeLabel: '',
      moqLabel: '',
      unitPriceLabel: '',
      wholesaleLabel: '',
      inquiryCta: '',
      oemInquiryCta: '',
      viewAllLabel: '',
      showLessLabel: '',
      imageUnavailableLabel: '',
      oemEyebrow: '',
      oemHeading: '',
      oemBody: '',
      relatedHeading: '',
      notFound: '',
    },
    families: [],
  };
  for (const key of ['headphones', 'ai-gadgets', 'toys', 'misc'] as const) {
    const family: CatalogFamilyContent = {
      key,
      label: key,
      href: `/${key}/`,
      eyebrow: '',
      heading: key,
      description: '',
      seoTitle: key,
      seoDescription: '',
      image: '',
      imageAlt: '',
      imageWidth: 1,
      imageHeight: 1,
      categories: [{ key: 'wired', label: 'Legacy wired' }],
    };
    const markup = renderToStaticMarkup(
      createElement(CatalogFamilyPage, {
        content,
        family,
      }),
    );
    assert.doesNotMatch(markup, /type="checkbox"/);
    assert.match(markup, /type="search"/);
  }
});

test('taxonomy requests use apiUrl, forward cancellation and reject invalid envelopes', async (context) => {
  const controller = new AbortController();
  const mockedFetch = context.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(input, apiUrl('/api/catalog-taxonomy?family=headphones'));
      assert.equal(init?.signal, controller.signal);
      return Response.json({ ok: true, data: taxonomy() });
    },
  );
  assert.equal((await fetchCatalogTaxonomy('headphones', controller.signal)).name, 'Audio');
  mockedFetch.mock.mockImplementation(async () =>
    Response.json({ ok: true, data: taxonomy({ family: 'toys' }) }),
  );
  await assert.rejects(fetchCatalogTaxonomy('headphones'));
  mockedFetch.mock.mockImplementation(async () =>
    Response.json({ ok: false, error: { message: 'Offline' } }, { status: 503 }),
  );
  await assert.rejects(fetchCatalogTaxonomy('headphones'));
});

test('catalog subcategory requests preserve the legacy API contract but never combine filters', async (context) => {
  const urls: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({ ok: true, data: { items: [], total: 0, page: 1, pageSize: 12 } });
  });
  await fetchCatalog('/api/products', {
    productFamily: 'headphones',
    subcategoryIds: ['headphones-wired', 'headphones-office'],
    page: 1,
    pageSize: 12,
  });
  const params = new URL(urls[0] ?? '', 'https://example.test').searchParams;
  assert.equal(params.get('subcategoryIds'), 'headphones-wired,headphones-office');
  assert.equal(params.has('category'), false);
  assert.equal(params.get('pageSize'), '12');
  await fetchCatalog('/api/products', { categories: ['wired'] });
  assert.equal(
    new URL(urls[1] ?? '', 'https://example.test').searchParams.get('category'),
    'wired',
  );
  await assert.rejects(
    fetchCatalog('/api/products', { categories: ['wired'], subcategoryIds: ['headphones-wired'] }),
  );
  await assert.rejects(fetchCatalog('/api/products', { subcategoryIds: [] }));
  await assert.rejects(fetchCatalog('/api/products', { subcategoryIds: ['bad,id'] }));
  assert.equal(urls.length, 2);
});

test('both public menus use the validated taxonomy source while preserving family links', () => {
  const source = readFileSync(
    new URL('../../components/SiteHeader.astro', import.meta.url),
    'utf8',
  );
  assert.equal((source.match(/data-taxonomy-family=\{family.key\}/g) ?? []).length, 2);
  assert.equal((source.match(/data-taxonomy-children/g) ?? []).length >= 2, true);
  assert.match(source, /fetchCatalogTaxonomy/);
  assert.match(source, /href=\{family.href\}/);
  assert.match(source, /data-taxonomy-retry/);
  assert.match(source, /searchParams.set\('category', child.id\)/);
  assert.match(source, /controller.signal.aborted/);
});
