import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import {
  type ApiResult,
  type CatalogTaxonomy,
  type CollectionDoc,
  FILTER_OPERATORS,
  type FilterModel,
  type ListResult,
  PRODUCT_FAMILY_OPTIONS,
  compareBySort,
  initialCatalogTaxonomy,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { listCatalog } from './handler.ts';
import { type HttpResponse, handlePublicApiEvent, parseCatalogQuery } from './http-adapter.ts';

class MemoryAdapter implements DbAdapter {
  readonly queries: AdapterListQuery[] = [];
  readonly reads: string[] = [];
  readonly countFilters: (FilterModel | undefined)[] = [];
  readonly pageFilters: (FilterModel | undefined)[] = [];
  failReads = false;

  constructor(readonly store: Record<string, CollectionDoc[]> = {}) {}

  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    this.reads.push(`${collection}/${id}`);
    if (this.failReads) throw new Error('Registry unavailable');
    return this.store[collection]?.find((doc) => doc._id === id) ?? null;
  }

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    this.queries.push(query);
    const select = (filter: FilterModel | undefined) =>
      (this.store[query.collection] ?? []).filter(
        (doc) =>
          (!filter || matchesFilter(doc, filter)) &&
          (!query.search || String(doc.name).toLowerCase().includes(query.search.toLowerCase())),
      );
    this.countFilters.push(query.filter);
    const total = select(query.filter).length;
    this.pageFilters.push(query.filter);
    const docs = select(query.filter).sort((left, right) =>
      compareBySort(left, right, query.sort ?? []),
    );
    const offset = (query.page - 1) * query.pageSize;
    return {
      items: docs.slice(offset, offset + query.pageSize),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findByField(): Promise<CollectionDoc | null> {
    throw new Error('Unexpected lookup');
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('Unexpected write');
  }
  async update(): Promise<CollectionDoc | null> {
    throw new Error('Unexpected write');
  }
  async remove(): Promise<boolean> {
    throw new Error('Unexpected write');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('Unexpected write');
  }
}

function product(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'product',
    name: 'Needle headphones',
    productFamily: 'headphones',
    published: true,
    archived: false,
    subcategoryIds: ['headphones-wired'],
    imageIds: [],
    unitPrice: 12,
    vipPrice: 8,
    ...overrides,
  };
}

function registry(overrides: Partial<CatalogTaxonomy> = {}): CollectionDoc {
  return {
    _id: 'headphones',
    ...initialCatalogTaxonomy('headphones'),
    revision: 3,
    ...overrides,
    updatedBy: 'private-user',
    updatedAt: '2026-09-18T00:00:00.000Z',
    privateNote: 'not public',
  };
}

function install(store: Record<string, CollectionDoc[]> = {}): MemoryAdapter {
  const adapter = new MemoryAdapter(store);
  setAdapter(adapter);
  return adapter;
}

function body<T>(response: HttpResponse): ApiResult<T> {
  return JSON.parse(response.body);
}

function request(path: string, extra: Record<string, unknown> = {}): Promise<HttpResponse> {
  return handlePublicApiEvent({ path, httpMethod: 'GET', ...extra }, {});
}

function predicate(value: unknown): FilterModel {
  return {
    combinator: 'and',
    clauses: [{ field: 'subcategoryIds', op: 'matchesProductSubcategories', value }],
  };
}

const selection = {
  family: 'headphones',
  ids: ['headphones-wired', 'headphones-office'],
  knownIds: ['headphones-wired', 'headphones-office', 'headphones-bluetooth'],
};

test('taxonomy returns default registries without writes for all four families and both prefixes', async () => {
  for (const family of PRODUCT_FAMILY_OPTIONS) {
    const adapter = install();
    for (const prefix of ['/api', '']) {
      const response = await request(`${prefix}/catalog-taxonomy?family=${family}`);
      assert.equal(response.statusCode, 200);
      const expected = initialCatalogTaxonomy(family);
      assert.deepEqual(body(response), {
        ok: true,
        data: {
          family,
          name: expected.name,
          revision: 0,
          children: expected.children.map(({ id, name, slug, order }) => ({
            id,
            name,
            slug,
            order,
          })),
        },
      });
    }
    assert.deepEqual(adapter.reads, [`catalogTaxonomies/${family}`, `catalogTaxonomies/${family}`]);
    assert.equal(adapter.queries.length, 0);
  }
});

test('taxonomy projects only public fields, orders children, and hides archived children', async () => {
  const [wired, office, bluetooth] = initialCatalogTaxonomy('headphones').children;
  assert.ok(wired && office && bluetooth);
  install({
    catalogTaxonomies: [
      registry({
        children: [
          { ...bluetooth, order: 0 },
          { ...wired, order: 2 },
          { ...office, status: 'archived' },
        ],
      }),
    ],
  });
  const response = await request('/api/catalog-taxonomy?family=headphones');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(body(response), {
    ok: true,
    data: {
      family: 'headphones',
      name: 'Headphones',
      revision: 3,
      children: [
        { id: 'headphones-bluetooth', name: 'Bluetooth Headphones', slug: 'bluetooth', order: 0 },
        { id: 'headphones-wired', name: 'Wired Headphones', slug: 'wired', order: 2 },
      ],
    },
  });
});

for (const query of [
  '',
  '?family=',
  '?family=unknown',
  '?family=Headphones',
  '?family=%20headphones',
  '?family=headphones&family=toys',
]) {
  test(`taxonomy rejects missing, invalid, or repeated family: ${query}`, async () => {
    const adapter = install();
    const response = await request(`/api/catalog-taxonomy${query}`);
    assert.equal(response.statusCode, 400);
    const result = body(response);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.equal(adapter.reads.length, 0);
  });
}

for (const stored of [
  { ...registry(), revision: -1 },
  { ...registry(), family: 'toys' },
  { ...registry(), children: null },
  { ...registry(), children: [{ id: 'bad' }] },
]) {
  test(`invalid stored taxonomy fails 500 without fallback: ${JSON.stringify(stored)}`, async () => {
    const adapter = install({ catalogTaxonomies: [stored] });
    for (const path of [
      '/api/catalog-taxonomy?family=headphones',
      '/api/products?productFamily=headphones&subcategoryIds=headphones-wired',
    ]) {
      const response = await request(path);
      assert.equal(response.statusCode, 500);
      const result = body(response);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'INTERNAL_ERROR');
    }
    assert.deepEqual(adapter.reads, [
      'catalogTaxonomies/headphones',
      'catalogTaxonomies/headphones',
    ]);
    assert.equal(adapter.queries.length, 0);
  });
}

test('registry read failure is an INTERNAL_ERROR envelope, not a default taxonomy', async () => {
  const adapter = install();
  adapter.failReads = true;
  assert.equal((await request('/api/catalog-taxonomy?family=headphones')).statusCode, 500);
  assert.equal(
    (await request('/api/products?productFamily=headphones&subcategoryIds=headphones-wired'))
      .statusCode,
    500,
  );
  assert.deepEqual(adapter.reads, ['catalogTaxonomies/headphones', 'catalogTaxonomies/headphones']);
});

test('HTTP query inputs preserve duplicate errors across gateway envelope shapes', async () => {
  const events = [
    { path: '/api/catalog-taxonomy', queryStringParameters: { family: ['headphones', 'toys'] } },
    {
      path: '/api/catalog-taxonomy',
      rawQueryString: 'family=headphones&family=toys',
      queryStringParameters: { family: 'headphones' },
    },
    {
      path: '/api/catalog-taxonomy?family=headphones&family=toys',
      queryStringParameters: { family: 'headphones' },
    },
    {
      path: '/api/catalog-taxonomy',
      multiValueQueryStringParameters: { family: ['headphones', 'toys'] },
      queryStringParameters: { family: 'headphones' },
    },
    {
      path: '/api/products',
      queryStringParameters: {
        productFamily: 'headphones',
        subcategoryIds: ['headphones-wired', 'headphones-office'],
      },
    },
    {
      path: '/api/products',
      rawQueryString:
        'productFamily=headphones&subcategoryIds=headphones-wired&subcategoryIds=headphones-office',
    },
    {
      path: '/api/products?productFamily=headphones&subcategoryIds=headphones-wired',
      queryStringParameters: { subcategoryIds: 'headphones-office' },
    },
  ];
  const adapter = install();
  for (const event of events) {
    const response = await handlePublicApiEvent(event, {});
    assert.equal(response.statusCode, 400, JSON.stringify(event));
  }
  assert.equal(adapter.queries.length, 0);
});

test('HTTP accepts mirrored single query values without treating them as duplicates', async () => {
  install();
  const response = await request('/api/catalog-taxonomy?family=headphones', {
    rawQueryString: 'family=headphones',
    queryStringParameters: { family: 'headphones' },
    multiValueQueryStringParameters: { family: ['headphones'] },
  });
  assert.equal(response.statusCode, 200);
});

test('parseCatalogQuery accepts strict comma-separated subcategory IDs and preserves legacy parsing', () => {
  assert.deepEqual(
    parseCatalogQuery(
      new URLSearchParams(
        'productFamily=headphones&subcategoryIds=headphones-wired,headphones-office&pageSize=12',
      ),
    ),
    {
      productFamily: 'headphones',
      subcategoryIds: ['headphones-wired', 'headphones-office'],
      search: '',
      page: 1,
      pageSize: 12,
    },
  );
  assert.deepEqual(parseCatalogQuery(new URLSearchParams('category=wired,office')), {
    categories: ['wired', 'office'],
    search: '',
    page: 1,
    pageSize: 24,
  });
});

for (const query of [
  'subcategoryIds=headphones-wired',
  'productFamily=&subcategoryIds=headphones-wired',
  'productFamily=headphones&productFamily=toys&subcategoryIds=headphones-wired',
  'productFamily=headphones&subcategoryIds=',
  'productFamily=headphones&subcategoryIds=headphones-wired,',
  'productFamily=headphones&subcategoryIds=headphones-wired,headphones-wired',
  'productFamily=headphones&subcategoryIds=headphones-wired,%20headphones-office',
  'productFamily=headphones&subcategoryIds=headphones-wired&subcategoryIds=headphones-office',
  'productFamily=headphones&subcategoryIds=headphones-wired&category=wired',
  'productFamily=headphones&subcategoryIds=headphones-wired&category=',
  'productFamily=headphones&subcategoryIds=headphones-wired%0A',
  `productFamily=headphones&subcategoryIds=${'x'.repeat(81)}`,
  `productFamily=headphones&subcategoryIds=${Array.from({ length: 17 }, (_, index) => `child-${index}`).join(',')}`,
]) {
  test(`invalid subcategory query rejects before database query: ${query}`, async () => {
    const adapter = install();
    assert.equal((await request(`/api/products?${query}`)).statusCode, 400);
    assert.equal(adapter.queries.length, 0);
  });
}

test('unknown, partially unknown, archived, and other-family selections never broaden the list', async () => {
  const initial = initialCatalogTaxonomy('headphones');
  const adapter = install({
    catalogTaxonomies: [
      registry({
        children: initial.children.map((child) =>
          child.id === 'headphones-office' ? { ...child, status: 'archived' } : child,
        ),
      }),
    ],
    products: [product()],
  });
  for (const ids of [
    'unknown',
    'headphones-wired,unknown',
    'headphones-office',
    'headphones-wired,headphones-office',
    'toys-plush',
  ]) {
    assert.equal(
      (await request(`/api/products?productFamily=headphones&subcategoryIds=${ids}`)).statusCode,
      400,
      ids,
    );
  }
  assert.equal(
    (await request('/api/products?productFamily=toys&subcategoryIds=headphones-wired')).statusCode,
    400,
  );
  assert.equal(
    (await request('/api/overstock?productFamily=headphones&subcategoryIds=headphones-wired'))
      .statusCode,
    400,
  );
  assert.equal(adapter.queries.length, 0);
});

test('handler rejects malformed direct selections and mixed legacy categories', async () => {
  const adapter = install();
  for (const query of [
    { subcategoryIds: ['headphones-wired'] },
    { productFamily: 'headphones' as const, subcategoryIds: [] },
    {
      productFamily: 'headphones' as const,
      subcategoryIds: ['headphones-wired', 'headphones-wired'],
    },
    {
      productFamily: 'headphones' as const,
      subcategoryIds: ['headphones-wired'],
      categories: ['wired'],
    },
  ]) {
    const result = await listCatalog('products', query, {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(adapter.queries.length, 0);
});

test('dedicated predicate applies OR membership within family AND, including absent legacy mapping', () => {
  const filter = predicate(selection);
  assert.equal(
    matchesFilter(product({ subcategoryIds: ['headphones-wired', 'headphones-office'] }), filter),
    true,
  );
  assert.equal(matchesFilter(product({ subcategoryIds: ['headphones-office'] }), filter), true);
  assert.equal(matchesFilter({ category: 'wired' }, filter), true);
  assert.equal(matchesFilter({ productFamily: 'headphones', category: 'wired' }, filter), true);
  assert.equal(matchesFilter({ productFamily: 'toys', category: 'wired' }, filter), false);
  assert.equal(matchesFilter(product({ productFamily: null }), filter), false);
  assert.equal(matchesFilter(product({ subcategoryIds: ['headphones-bluetooth'] }), filter), false);
  assert.equal(
    (FILTER_OPERATORS as readonly string[]).includes('matchesProductSubcategories'),
    false,
  );
});

test('dedicated predicate rejects malformed stored assignments without legacy fallback', () => {
  for (const subcategoryIds of [
    undefined,
    null,
    'headphones-wired',
    1,
    [1],
    ['headphones-wired', 1],
    ['headphones-wired', 'headphones-wired'],
    ['headphones-wired', 'unknown'],
    ['headphones-wired', 'toys-plush'],
    [],
    Array.from({ length: 17 }, () => 'headphones-wired'),
  ]) {
    assert.equal(
      matchesFilter(product({ category: 'wired', subcategoryIds }), predicate(selection)),
      false,
      JSON.stringify(subcategoryIds),
    );
  }
});

test('dedicated predicate rejects malformed predicate values and known ID registries', () => {
  for (const value of [
    null,
    [],
    {},
    { ...selection, family: 'other' },
    { ...selection, ids: 'headphones-wired' },
    { ...selection, ids: [] },
    { ...selection, ids: ['headphones-wired', 'unknown'] },
    { ...selection, ids: ['headphones-wired', 'headphones-wired'] },
    { ...selection, knownIds: null },
    { ...selection, knownIds: ['headphones-wired', 1] },
    { ...selection, knownIds: ['headphones-wired', 'headphones-wired'] },
    { ...selection, knownIds: Array.from({ length: 65 }, (_, index) => `child-${index}`) },
  ]) {
    assert.equal(matchesFilter(product(), predicate(value)), false, JSON.stringify(value));
  }
});

test('ID validation accepts the 16 assignment and 64 known ID boundaries but rejects sparse and newline IDs', () => {
  const knownIds = Array.from({ length: 64 }, (_, index) =>
    index === 0 ? 'x'.repeat(80) : `child-${index}`,
  );
  const ids = knownIds.slice(0, 16);
  const query = parseCatalogQuery(
    new URLSearchParams({ productFamily: 'headphones', subcategoryIds: ids.join(',') }),
  );
  assert.ok(!('ok' in query));
  assert.deepEqual(query.subcategoryIds, ids);
  assert.equal(
    matchesFilter(
      product({ subcategoryIds: ids }),
      predicate({ family: 'headphones', ids, knownIds }),
    ),
    true,
  );
  const newline = 'headphones-wired\n';
  assert.equal(
    matchesFilter(
      product({ subcategoryIds: [newline] }),
      predicate({ family: 'headphones', ids: [newline], knownIds: [newline] }),
    ),
    false,
  );
  assert.equal(matchesFilter(product(), predicate({ ...selection, ids: new Array(1) })), false);
  assert.equal(
    matchesFilter(product(), predicate({ ...selection, knownIds: new Array(1) })),
    false,
  );
});

test('configured subcategories filter every family without accepting another family with the same child ID', async () => {
  for (const family of PRODUCT_FAMILY_OPTIONS) {
    const taxonomy: CatalogTaxonomy = {
      ...initialCatalogTaxonomy(family),
      children: [
        {
          id: 'shared-child',
          name: 'Shared child',
          slug: 'shared-child',
          order: 0,
          status: 'active',
        },
      ],
    };
    install({
      catalogTaxonomies: [{ ...registry(taxonomy), _id: family }],
      products: PRODUCT_FAMILY_OPTIONS.map((productFamily) =>
        product({ _id: productFamily, productFamily, subcategoryIds: ['shared-child'] }),
      ),
    });
    const response = await request(
      `/api/products?productFamily=${family}&subcategoryIds=shared-child`,
    );
    assert.equal(response.statusCode, 200);
    const result = body<ListResult<CollectionDoc>>(response);
    assert.equal(result.ok && result.data.total, 1);
    assert.deepEqual(result.ok && result.data.items.map((item) => item._id), [family]);
  }
});

test('count and 12-item pages share the complete filter with unique OR matches and search AND', async () => {
  const products = Array.from({ length: 25 }, (_, index) =>
    product({
      _id: `p-${String(index).padStart(2, '0')}`,
      subcategoryIds:
        index % 3 === 0
          ? ['headphones-wired', 'headphones-office']
          : index % 3 === 1
            ? ['headphones-wired']
            : ['headphones-office'],
    }),
  );
  products.push(
    product({ _id: 'no-search', name: 'Other' }),
    product({ _id: 'wrong-family', productFamily: 'toys' }),
    product({ _id: 'unpublished', published: false }),
    product({ _id: 'archived', archived: true }),
    product({ _id: 'bad-membership', subcategoryIds: ['headphones-wired', 'unknown'] }),
  );
  const adapter = install({ products });
  const ids: string[] = [];
  for (const page of [1, 2, 3]) {
    const response = await request(
      `/api/products?productFamily=headphones&subcategoryIds=headphones-wired,headphones-office&search=needle&pageSize=12&page=${page}`,
    );
    assert.equal(response.statusCode, 200);
    const result = body<ListResult<CollectionDoc>>(response);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('Expected list');
    assert.equal(result.data.total, 25);
    assert.equal(result.data.page, page);
    assert.equal(result.data.pageSize, 12);
    assert.equal(result.data.items.length, page < 3 ? 12 : 1);
    ids.push(...result.data.items.map((item) => item._id));
    for (const item of result.data.items) {
      assert.equal(Object.hasOwn(item, 'subcategoryIds'), false);
      assert.equal(Object.hasOwn(item, 'vipPrice'), false);
    }
  }
  assert.equal(new Set(ids).size, 25);
  assert.deepEqual(
    ids,
    products.slice(0, 25).map((item) => item._id),
  );
  const queries = adapter.queries.filter((query) => query.collection === 'products');
  assert.equal(queries.length, 3);
  for (const query of queries) {
    assert.equal(query.filter?.combinator, 'and');
    assert.deepEqual(
      query.filter?.clauses.find((clause) => clause.op === 'matchesProductSubcategories')?.value,
      selection,
    );
  }
  for (const [index, filter] of adapter.countFilters.entries())
    assert.equal(filter, adapter.pageFilters[index]);
});

test('archived membership remains on main list and valid active matches; legacy response is unchanged', async () => {
  const initial = initialCatalogTaxonomy('headphones');
  const adapter = install({
    catalogTaxonomies: [
      registry({
        children: initial.children.map((child) =>
          child.id === 'headphones-office' ? { ...child, status: 'archived' } : child,
        ),
      }),
    ],
    products: [
      product({ _id: 'archived-only', subcategoryIds: ['headphones-office'] }),
      product({ _id: 'both', subcategoryIds: ['headphones-office', 'headphones-wired'] }),
      { _id: 'legacy', name: 'Legacy', category: 'wired', published: true },
    ],
  });
  const main = body<ListResult<CollectionDoc>>(
    await request('/api/products?productFamily=headphones'),
  );
  assert.equal(main.ok && main.data.total, 3);
  assert.equal(adapter.reads.length, 0);
  const filtered = body<ListResult<CollectionDoc>>(
    await request('/api/products?productFamily=headphones&subcategoryIds=headphones-wired'),
  );
  assert.deepEqual(filtered.ok && filtered.data.items.map((item) => item._id), ['both', 'legacy']);
  const legacy = body<ListResult<CollectionDoc>>(await request('/api/products?category=wired'));
  assert.deepEqual(legacy.ok && legacy.data.items, [
    {
      _id: 'legacy',
      images: [],
      name: 'Legacy',
      published: true,
      productFamily: 'headphones',
      category: 'wired',
    },
  ]);
});

test('an empty family returns a successful empty list without requiring a registry', async () => {
  const adapter = install({ products: [product()] });
  const result = body<ListResult<CollectionDoc>>(
    await request('/api/products?productFamily=toys&pageSize=12'),
  );
  assert.deepEqual(result, { ok: true, data: { items: [], total: 0, page: 1, pageSize: 12 } });
  assert.equal(adapter.reads.length, 0);
});
