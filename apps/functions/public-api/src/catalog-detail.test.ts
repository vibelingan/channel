/** The product page reads the same public version as the list (MIU-9, DEC-1). */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
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
