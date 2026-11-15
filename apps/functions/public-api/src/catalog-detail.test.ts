/** The product page reads the same public version as the list (MIU-9, DEC-1). */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  initialCatalogTaxonomy,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { getProductDetail } from './catalog-detail.ts';

type Store = Record<string, CollectionDoc[]>;

class ReadOnlyAdapter implements DbAdapter {
  constructor(private readonly store: Store) {}
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    let docs = [...(this.store[query.collection] ?? [])];
    if (query.filter) {
      const filter = query.filter;
      docs = docs.filter((doc) => matchesFilter(doc, filter));
    }
    if (query.sort && query.sort.length > 0) {
      docs.sort((a, b) => compareBySort(a, b, query.sort ?? []));
    }
    const start = (query.page - 1) * query.pageSize;
    return {
      items: docs.slice(start, start + query.pageSize),
      total: docs.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return (this.store[collection] ?? []).find((doc) => doc._id === id) ?? null;
  }
  async findByField(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
  async update(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async remove(): Promise<boolean> {
    throw new Error('not used');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
}

const header = (id: string) => ({
  schemaVersion: 'catalog-product-detail-v1',
  _id: id,
  name: 'Approved headset',
  images: [],
  facts: [{ name: 'Series', value: 'S1' }],
  offers: [],
  websitePricing: {
    basis: 'website-manual',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: 430, minimumOrderQuantity: 1000 },
  },
});
const approved = (id: string, extra: Record<string, unknown> = {}): CollectionDoc => ({
  _id: id,
  name: 'Row name',
  published: true,
  catalogDetailPublication: {
    state: 'approved',
    revision: 'r1',
    header: header(id),
    variantCount: 0,
    variantStorage: 'immutable-v1',
  },
  ...extra,
});

test('an approved synced product serves its approved version', async () => {
  setAdapter(
    new ReadOnlyAdapter({ products: [approved('synced', { alibabaPrimarySourceKey: 'k' })] }),
  );
  const result = await getProductDetail('synced');
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.data.name, 'Approved headset');
    assert.equal(result.data.variants.total, 0);
  }
});

test('an approved manual product (no configurations, website price) serves the same detail shape', async () => {
  setAdapter(new ReadOnlyAdapter({ products: [approved('manual')] }));
  const result = await getProductDetail('manual');
  assert.ok(result.ok);
  // The whole response: the approved header plus revision and an empty
  // configuration page, nothing from the row (row name, row prices).
  if (result.ok)
    assert.deepEqual(result.data, {
      ...header('manual'),
      revision: 'r1',
      variants: { items: [], total: 0, page: 1, pageSize: 50, hasMore: false },
    });
});

test('a product not yet approved, or with a mismatched version, is not found (row fallback page)', async () => {
  setAdapter(
    new ReadOnlyAdapter({
      products: [
        { _id: 'row', name: 'Row only', published: true },
        approved('mismatch', {
          catalogDetailPublication: {
            state: 'approved',
            revision: 'r1',
            header: header('someone-else'),
            variantCount: 0,
          },
        }),
      ],
    }),
  );
  for (const id of ['row', 'mismatch']) {
    const result = await getProductDetail(id);
    assert.equal(result.ok, false, id);
    if (!result.ok) assert.equal(result.error.code, 'NOT_FOUND', id);
  }
});

test('byte-negotiated detail keeps fifty legal large configurations below browser and function response limits', async () => {
  const { CatalogDetailVariantSchema } = await import('@vibelingan-channel/shared/catalog-detail');
  const { catalogVariantCapacityIssues } = await import(
    '@vibelingan-channel/shared/catalog-detail-approval'
  );
  const { approvedVariantDocumentId } = await import(
    '@vibelingan-channel/db/catalog-detail-storage'
  );
  const { handlePublicApiEvent } = await import('./http-adapter.ts');
  const variants = Array.from({ length: 50 }, (_, position) =>
    CatalogDetailVariantSchema.parse({
      id: `large-${position}`,
      options: Array.from({ length: 42 }, (_, i) => ({
        name: `Option ${i}`,
        value: '中'.repeat(1000),
      })),
      images: [],
      offers: [],
      inventory: { state: 'unknown' },
    }),
  );
  assert.deepEqual(catalogVariantCapacityIssues(variants), [], 'each full configuration is legal');
  const publication = {
    state: 'approved',
    revision: 'r1',
    header: header('bounded'),
    variantCount: variants.length,
    variantStorage: 'immutable-v1',
  };
  setAdapter(
    new ReadOnlyAdapter({
      products: [
        approved('bounded', {
          catalogDetailPublication: publication,
          catalogDetailPagination: {
            policyVersion: 'catalog-detail-pagination-v1',
            revision: 'r1',
            pageSize: 10,
          },
        }),
      ],
      catalogDetailVariants: variants.map((v, position) => ({
        _id: approvedVariantDocumentId('bounded', 'r1', v.id),
        productId: 'bounded',
        variantId: v.id,
        catalogDetailRevision: 'r1',
        catalogDetailPosition: position,
        catalogDetailApproved: v,
      })),
    }),
  );
  const result = await handlePublicApiEvent(
    {
      httpMethod: 'GET',
      path: '/api/products/bounded/detail?page=1&pageSize=50&view=sections-media&pagination=byte-budget-v1',
    },
    { jwtSecret: 'test', enableCatalogDetail: true },
  );
  assert.equal(result.statusCode, 200);
  assert.ok(
    Buffer.byteLength(result.body) < 2 * 1024 * 1024,
    'actual HTTP body must fit the existing browser budget',
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) < 5_000_000,
    'actual function envelope keeps margin below6MB',
  );
  const envelope: unknown = JSON.parse(result.body);
  const { decodeCatalogDetailView } = await import('@vibelingan-channel/shared/catalog-detail');
  assert.ok(envelope && typeof envelope === 'object' && 'data' in envelope);
  const decoded = decodeCatalogDetailView(envelope.data);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.variants.total, 50);
  assert.equal(decoded.value.variants.pageSize, 10);
  assert.deepEqual(decoded.value.variants.items, variants.slice(0, 10));
  const seen = [...decoded.value.variants.items];
  for (let page = 2; page <= 5; page++) {
    const next = await handlePublicApiEvent(
      {
        httpMethod: 'GET',
        path: `/api/products/bounded/detail?page=${page}&pageSize=10&revision=r1&view=sections-media&pagination=byte-budget-v1`,
      },
      { jwtSecret: 'test', enableCatalogDetail: true },
    );
    assert.equal(next.statusCode, 200);
    assert.ok(Buffer.byteLength(next.body) < 2 * 1024 * 1024);
    const body: unknown = JSON.parse(next.body);
    assert.ok(body && typeof body === 'object' && 'data' in body);
    const detail = decodeCatalogDetailView(body.data);
    assert.ok(detail.ok);
    assert.equal(detail.value.variants.pageSize, 10);
    assert.equal(detail.value.variants.page, page);
    seen.push(...detail.value.variants.items);
  }
  assert.deepEqual(seen, variants, 'every approved configuration is returned exactly once');
});

for (const hint of [
  { policyVersion: 'catalog-detail-pagination-v1', revision: 'other', pageSize: 10 },
  { policyVersion: 'catalog-detail-pagination-v1', revision: 'r1', pageSize: 51 },
  { policyVersion: 'old', revision: 'r1', pageSize: 10 },
])
  test('an invalid or stale private paging hint cannot silently mix approved pages', async () => {
    setAdapter(
      new ReadOnlyAdapter({ products: [approved('p', { catalogDetailPagination: hint })] }),
    );
    const result = await getProductDetail('p', 1, 50, undefined, true, true, true, true);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'INTERNAL_ERROR');
  });

test('legacy small detail requests remain compatible without byte negotiation', async () => {
  setAdapter(
    new ReadOnlyAdapter({
      products: [
        approved('p', {
          catalogDetailPagination: {
            policyVersion: 'catalog-detail-pagination-v1',
            revision: 'r1',
            pageSize: 10,
          },
        }),
      ],
    }),
  );
  const result = await getProductDetail('p');
  assert.ok(result.ok);
  assert.equal(result.data.variants.pageSize, 50);
  assert.equal(Object.hasOwn(result.data, 'catalogDetailPagination'), false);
});

// The current revision may have fewer pages than the obsolete one.
test('stale revision wins over an out-of-range page so the browser can refresh', async () => {
  setAdapter(new ReadOnlyAdapter({ products: [approved('reduced')] }));
  const stale = await getProductDetail(
    'reduced',
    2,
    50,
    'obsolete-revision',
    false,
    false,
    false,
    true,
  );
  assert.ok(!stale.ok);
  assert.equal(stale.error.code, 'CONFLICT');
  const current = await getProductDetail('reduced', 2, 50, 'r1', false, false, false, true);
  assert.ok(!current.ok);
  assert.equal(current.error.code, 'VALIDATION_ERROR');
});

test('public content tracking detects a real API change beyond the first detail page', async () => {
  const { approvedVariantDocumentId } = await import(
    '@vibelingan-channel/db/catalog-detail-storage'
  );
  const { prepareCatalogPublicState } = await import(
    '@vibelingan-channel/db/catalog-public-content'
  );
  const product = approved('paged', {
    productFamily: 'misc',
    catalogDetailPublication: {
      state: 'approved',
      revision: 'r1',
      header: header('paged'),
      variantCount: 60,
      variantStorage: 'immutable-v1',
    },
  });
  const rows: CollectionDoc[] = Array.from({ length: 60 }, (_, i) => ({
    _id: approvedVariantDocumentId('paged', 'r1', `v${i}`),
    productId: 'paged',
    variantId: `v${i}`,
    catalogDetailRevision: 'r1',
    catalogDetailPosition: i,
    catalogDetailApproved: {
      id: `v${i}`,
      sku: `SKU-${i}`,
      options: [],
      images: [],
      inventory: { state: 'unknown' },
      offers: [],
    },
  }));
  const store = { products: [product], catalogDetailVariants: rows };
  setAdapter(new ReadOnlyAdapter(store));
  const first = await getProductDetail('paged', 1);
  const second = await getProductDetail('paged', 2);
  const before = prepareCatalogPublicState({
    product,
    taxonomy: initialCatalogTaxonomy('misc'),
    detailEnabled: true,
    variants: { kind: 'approved', total: 60, items: rows },
  });
  const target = rows[55];
  assert.ok(target);
  target.catalogDetailApproved = {
    id: 'v55',
    sku: 'Changed public SKU',
    options: [],
    images: [],
    inventory: { state: 'unknown' },
    offers: [],
  };
  assert.deepEqual(
    await getProductDetail('paged', 1),
    first,
    'the first page alone cannot reveal this change',
  );
  const changed = await getProductDetail('paged', 2);
  assert.notDeepEqual(changed, second);
  assert.ok(changed.ok);
  if (changed.ok) assert.equal(changed.data.variants.items[5]?.sku, 'Changed public SKU');
  assert.notDeepEqual(
    prepareCatalogPublicState({
      product,
      taxonomy: initialCatalogTaxonomy('misc'),
      detailEnabled: true,
      variants: { kind: 'approved', total: 60, items: rows },
    }),
    before,
  );
});

test('public row variants and change tracking use the same deterministic capped order', async () => {
  const { getCatalogItem } = await import('./handler.ts');
  const { prepareCatalogPublicState } = await import(
    '@vibelingan-channel/db/catalog-public-content'
  );
  const product: CollectionDoc = {
    _id: 'p',
    name: 'Legacy',
    published: true,
    productFamily: 'misc',
  };
  const rows: CollectionDoc[] = Array.from({ length: 51 }, (_, i) => ({
    _id: `v${String(i).padStart(2, '0')}`,
    productId: 'p',
    position: 1,
    sku: `SKU-${i}`,
  }));
  setAdapter(new ReadOnlyAdapter({ products: [product], productVariants: [...rows].reverse() }));
  const first = await getCatalogItem('products', 'p', {});
  assert.ok(first.ok);
  if (first.ok) {
    const data = first.data;
    assert.ok(data && typeof data === 'object' && 'variants' in data);
    assert.ok(Array.isArray(data.variants));
    assert.equal(data.variants.length, 50);
    assert.deepEqual(
      data.variants.map((v) => v.id),
      rows.slice(0, 50).map((v) => v._id),
    );
  }
  const before = prepareCatalogPublicState({
    product,
    taxonomy: initialCatalogTaxonomy('misc'),
    detailEnabled: false,
    variants: { kind: 'row', total: 51, items: rows },
  });
  const last = rows[50];
  assert.ok(last);
  last.sku = 'Hidden configuration';
  assert.deepEqual(await getCatalogItem('products', 'p', {}), first);
  assert.deepEqual(
    prepareCatalogPublicState({
      product,
      taxonomy: initialCatalogTaxonomy('misc'),
      detailEnabled: false,
      variants: { kind: 'row', total: 51, items: rows },
    }),
    before,
  );
  last.position = -1;
  assert.notDeepEqual(await getCatalogItem('products', 'p', {}), first);
  assert.notDeepEqual(
    prepareCatalogPublicState({
      product,
      taxonomy: initialCatalogTaxonomy('misc'),
      detailEnabled: false,
      variants: { kind: 'row', total: 51, items: rows },
    }),
    before,
  );
});
