/**
 * Storefront projection of imported variants.
 *
 * Two things are being defended here. The first is that a visitor never sees
 * the merchant's shop names, their source CNY prices, or a stock number the
 * shops disagreed about. The second is that products which predate this
 * feature — legacy rows and Alibaba-linked rows — come back BYTE-IDENTICAL:
 * adding variants to the catalog must not perturb what the storefront already
 * renders.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { getCatalogItem, listCatalog } from './handler.ts';

type Store = Record<string, CollectionDoc[]>;

/** Minimal read-only adapter: the projection under test never writes. */
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
  async findByField(collection: string, field: string, value: unknown) {
    return (this.store[collection] ?? []).find((doc) => doc[field] === value) ?? null;
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

const CONFIG = { jwtSecret: 'test-secret' };

const importedProduct: CollectionDoc = {
  _id: 'imported-1',
  name: 'Imported earbuds',
  productFamily: 'misc',
  description: 'A description',
  imageIds: ['img-1'],
  published: true,
  archived: false,
};

const legacyProduct: CollectionDoc = {
  _id: 'legacy-1',
  name: 'Hand-entered headphones',
  productFamily: 'headphones',
  category: 'bluetooth',
  description: 'Legacy description',
  imageIds: ['img-2'],
  unitPrice: 19.99,
  published: true,
  archived: false,
};

const alibabaProduct: CollectionDoc = {
  _id: 'alibaba-1',
  name: 'Alibaba-linked product',
  productFamily: 'misc',
  description: 'Linked description',
  imageIds: ['img-3'],
  published: true,
  archived: false,
  alibabaPrimarySourceKey: 'sha256-of-supplier-ids',
  alibabaSourceStatus: 'available',
  alibabaCatalogPricing: {
    schemaVersion: '1',
    source: 'alibaba',
    mode: 'fixed',
    amountMinor: 4200,
    currency: 'CNY',
    syncedAt: '2026-08-01T00:00:00.000Z',
    sourceOfferKey: 'must-not-ship',
  },
};

const variants: CollectionDoc[] = [
  {
    _id: 'variant-b',
    productId: 'imported-1',
    sku: 'SKU-2',
    position: 1,
    optionValues: { Color: 'White' },
    inventoryState: 'known',
    inventoryQuantity: 40,
    inventorySnapshots: [
      { storeKey: 'LingAn_MY', quantity: 40 },
      { storeKey: 'LingAn_SG', quantity: 40 },
    ],
    sourceRegularPrice: { amountMinor: 129900, currency: 'CNY' },
  },
  {
    _id: 'variant-a',
    productId: 'imported-1',
    sku: 'SKU-1',
    position: 0,
    optionValues: { Color: 'Black' },
    inventoryState: 'conflict',
    inventorySnapshots: [
      { storeKey: 'LingAn_MY', quantity: 12 },
      { storeKey: 'LingAn_SG', quantity: 40 },
    ],
    sourceRegularPrice: { amountMinor: 129900, currency: 'CNY' },
  },
];

function wire(store: Store): void {
  setAdapter(new ReadOnlyAdapter(store));
}

function itemsOf(result: unknown): CollectionDoc[] {
  const data = (result as { data?: { items?: CollectionDoc[] } }).data;
  return data?.items ?? [];
}

test('an imported product ships its variants in position order', async () => {
  wire({ products: [importedProduct], productVariants: variants });
  const items = itemsOf(await listCatalog('products', {}, CONFIG));
  const product = items[0] as { variants?: { sku: string }[] };
  assert.deepEqual(
    product.variants?.map((variant) => variant.sku),
    ['SKU-1', 'SKU-2'],
  );
});

test('an exact stock count is published; a disputed one is not', async () => {
  wire({ products: [importedProduct], productVariants: variants });
  const items = itemsOf(await listCatalog('products', {}, CONFIG));
  const shipped = (items[0] as { variants?: { sku: string; inventory?: number }[] }).variants ?? [];
  const agreed = shipped.find((variant) => variant.sku === 'SKU-2');
  const disputed = shipped.find((variant) => variant.sku === 'SKU-1');

  assert.equal(agreed?.inventory, 40, 'the agreed value, not the 80 that summing would give');
  assert.equal(Object.hasOwn(disputed ?? {}, 'inventory'), false, 'no number for a conflict');
});

test('shop names, source prices and reconciliation state never reach a visitor', async () => {
  wire({ products: [importedProduct], productVariants: variants });
  const payload = JSON.stringify(await listCatalog('products', {}, CONFIG));

  for (const secret of [
    'LingAn_MY',
    'LingAn_SG',
    'inventorySnapshots',
    'sourceRegularPrice',
    'sourcePromotionPrice',
    'inventoryState',
    'amountMinor',
    'dianxiaomi',
    'candidateSkuKey',
    'sourceVariantKey',
  ]) {
    assert.equal(payload.includes(secret), false, `${secret} must not be public`);
  }
});

test('the public variant shape is exactly id, sku, optionValues and inventory', async () => {
  wire({ products: [importedProduct], productVariants: variants });
  const items = itemsOf(await listCatalog('products', {}, CONFIG));
  const shipped = (items[0] as { variants?: Record<string, unknown>[] }).variants ?? [];
  for (const variant of shipped) {
    for (const key of Object.keys(variant)) {
      assert.ok(
        ['id', 'sku', 'optionValues', 'inventory'].includes(key),
        `unexpected public variant field ${key}`,
      );
    }
  }
});

test('a legacy product without variants is byte-identical to before', async () => {
  wire({ products: [legacyProduct] });
  const withoutCollection = itemsOf(await listCatalog('products', {}, CONFIG));

  wire({ products: [legacyProduct], productVariants: variants });
  const withCollection = itemsOf(await listCatalog('products', {}, CONFIG));

  assert.deepEqual(withCollection, withoutCollection);
  assert.equal(Object.hasOwn(withCollection[0] ?? {}, 'variants'), false);
});

test('an Alibaba-linked product is byte-identical and still hides offer provenance', async () => {
  wire({ products: [alibabaProduct] });
  const before = itemsOf(await listCatalog('products', {}, CONFIG));

  wire({ products: [alibabaProduct], productVariants: variants });
  const after = itemsOf(await listCatalog('products', {}, CONFIG));

  assert.deepEqual(after, before);
  const payload = JSON.stringify(after);
  assert.equal(payload.includes('must-not-ship'), false, 'offer provenance stays server-side');
  assert.equal(payload.includes('sha256-of-supplier-ids'), false);
  assert.ok(payload.includes('"alibabaPrimarySourceKey":"linked"'));
});

test('a single-item fetch carries the same variants as the list', async () => {
  wire({ products: [importedProduct], productVariants: variants });
  const single = (await getCatalogItem('products', 'imported-1', CONFIG)) as {
    data?: { variants?: { sku: string }[] };
  };
  assert.deepEqual(
    single.data?.variants?.map((variant) => variant.sku),
    ['SKU-1', 'SKU-2'],
  );
});

test('a variant belonging to another product is never attached', async () => {
  wire({
    products: [importedProduct],
    productVariants: [{ ...(variants[0] as CollectionDoc), productId: 'someone-else' }],
  });
  const items = itemsOf(await listCatalog('products', {}, CONFIG));
  assert.equal(Object.hasOwn(items[0] ?? {}, 'variants'), false);
});

test('an archived variant is withheld from the storefront', async () => {
  wire({
    products: [importedProduct],
    productVariants: [{ ...(variants[0] as CollectionDoc), archived: true }],
  });
  const items = itemsOf(await listCatalog('products', {}, CONFIG));
  assert.equal(Object.hasOwn(items[0] ?? {}, 'variants'), false);
});

test('overstock is untouched by the variant path', async () => {
  const overstock: CollectionDoc = {
    _id: 'over-1',
    name: 'Clearance lot',
    category: 'electronics',
    inventory: 500,
    published: true,
  };
  wire({ overstock: [overstock], productVariants: variants });
  const items = itemsOf(await listCatalog('overstock', {}, CONFIG));
  assert.equal(Object.hasOwn(items[0] ?? {}, 'variants'), false);
  assert.equal(items[0]?.inventory, 500);
});
