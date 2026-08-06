import { strict as assert } from 'node:assert';
import test from 'node:test';
import { alibabaOfferKey, alibabaSourceKey } from '@vibelingan-channel/alibaba-catalog-sync';
import type { AdapterListQuery, AlibabaLeaseGuard, DbAdapter } from '@vibelingan-channel/db';
import { holdsAlibabaLease, setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { setPinnedOffer } from './linking.ts';
import { promoteLinkedProduct } from './promotion.ts';

type Store = Record<string, CollectionDoc[]>;

class FencedMemoryAdapter implements DbAdapter {
  constructor(readonly store: Store) {}
  private docs(collection: string): CollectionDoc[] {
    this.store[collection] ??= [];
    return this.store[collection] as CollectionDoc[];
  }
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    let docs = [...this.docs(query.collection)];
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
    return this.docs(collection).find((d) => d._id === id) ?? null;
  }
  async findByField(): Promise<CollectionDoc | null> {
    return null;
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return null;
    const next = { ...(docs[index] as CollectionDoc), ...data } as CollectionDoc;
    docs[index] = next;
    return next;
  }
  async remove(): Promise<boolean> {
    throw new Error('not used');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
  async updateDocWithAlibabaLease(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<boolean> {
    const lease = this.docs('alibabaSyncLeases').find((d) => d._id === guard.connectionId) ?? null;
    if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return false;
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return false;
    docs[index] = { ...(docs[index] as CollectionDoc), ...patch };
    return true;
  }
}

const NOW = '2026-08-06T12:00:00.000Z';
const SOURCE_KEY = alibabaSourceKey('primary', '987');
const OFFER_KEY = alibabaOfferKey('primary', '987', 'sku-1');
const GUARD: AlibabaLeaseGuard = { connectionId: 'primary', holder: 'run-1', fence: 2, now: NOW };

const liveLease: CollectionDoc = {
  _id: 'primary',
  holder: 'run-1',
  fence: 2,
  acquiredAt: NOW,
  heartbeatAt: NOW,
  expiresAt: '2026-08-06T12:03:00.000Z',
  releasedAt: '',
} as CollectionDoc;

const basePricing = {
  schemaVersion: 'alibaba-catalog-pricing-v1',
  source: 'alibaba',
  mode: 'fixed',
  currency: 'USD',
  amountMinor: 250,
  syncedAt: '2026-08-01T00:00:00.000Z',
};

/** Active fixed-price offer on the shared source, at a given minor amount. */
function offerDoc(
  id: string,
  sourceKey: string,
  skuId: string,
  amountMinor: number,
): CollectionDoc {
  return {
    _id: id,
    sourceKey,
    sourceSkuId: skuId,
    active: true,
    pricing: { ...basePricing, amountMinor },
  } as CollectionDoc;
}

let store: Store = {};
function setup(overrides: Partial<Store> = {}): Store {
  store = {
    alibabaSyncLeases: [liveLease],
    alibabaProductLinks: [
      { _id: SOURCE_KEY, sourceKey: SOURCE_KEY, productId: 'p-1' } as CollectionDoc,
    ],
    alibabaSourceProducts: [
      { _id: SOURCE_KEY, sourceKey: SOURCE_KEY, active: true } as CollectionDoc,
    ],
    alibabaSupplierOffers: [
      {
        _id: OFFER_KEY,
        sourceKey: SOURCE_KEY,
        sourceSkuId: 'sku-1',
        active: true,
        pricing: basePricing,
      } as CollectionDoc,
    ],
    products: [
      {
        _id: 'p-1',
        name: 'Curated Name',
        category: 'bluetooth',
        description: 'curated description',
        moq: 10,
        unitPrice: 12.5,
        wholesalePrice: 10,
        vipPrice: 8,
        published: true,
        imageIds: ['img-1'],
        alibabaPrimarySourceKey: SOURCE_KEY,
      } as CollectionDoc,
    ],
    ...overrides,
  };
  setAdapter(new FencedMemoryAdapter(store));
  return store;
}

test('promotion materializes the primary offer through the fenced write, touching ONLY Alibaba fields', async () => {
  setup();
  const before = { ...(store.products?.[0] as CollectionDoc) };
  const result = await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  assert.equal(result.priceMoveAlert, false);
  const after = store.products?.[0] as CollectionDoc;
  assert.equal(after.alibabaPrimaryOfferKey, OFFER_KEY);
  assert.equal((after.alibabaCatalogPricing as { amountMinor?: number }).amountMinor, 250);
  assert.equal(after.alibabaSourceStatus, 'available');
  assert.equal(after.alibabaSourceLastSyncedAt, NOW);
  // Every non-Alibaba field is byte-identical (protected-surface proof).
  for (const key of Object.keys(before)) {
    if (key.startsWith('alibaba')) continue;
    assert.deepEqual(after[key], before[key], `${key} must be untouched`);
  }
});

test('a stale holder cannot promote after fence takeover (write rejected, doc untouched)', async () => {
  setup();
  const before = JSON.stringify(store.products?.[0]);
  const staleGuard: AlibabaLeaseGuard = { ...GUARD, fence: 1 };
  const result = await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: staleGuard, now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'fence-rejected' });
  assert.equal(JSON.stringify(store.products?.[0]), before, 'no partial write');
});

test('link-identity mismatch aborts before any write', async () => {
  setup();
  const products = store.products as CollectionDoc[];
  products[0] = { ...(products[0] as CollectionDoc), alibabaPrimarySourceKey: 'different-key' };
  const result = await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'link-identity-mismatch' });
});

test('unlinked sources and missing products are reported without writes', async () => {
  setup({ alibabaProductLinks: [] });
  assert.deepEqual(await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW }), {
    ok: false,
    reason: 'not-linked',
  });
  setup({ products: [] });
  assert.deepEqual(await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW }), {
    ok: false,
    reason: 'product-missing',
  });
});

test('a >30% price move applies but raises the alert; unchanged repromotion reports changed=false', async () => {
  setup();
  const products = store.products as CollectionDoc[];
  products[0] = {
    ...(products[0] as CollectionDoc),
    alibabaCatalogPricing: { ...basePricing, amountMinor: 100 },
  };
  const result = await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.priceMoveAlert, true, '100 -> 250 is a >30% move');
  assert.equal(
    (store.products?.[0]?.alibabaCatalogPricing as { amountMinor?: number }).amountMinor,
    250,
    'healthy runs still apply the move',
  );

  // Second promotion with identical source state: applied, but changed=false.
  const again = await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.changed, false);
});

test('source deletion demotes to removed + canonical unavailable while preserving legacy fields', async () => {
  setup({
    alibabaSourceProducts: [
      { _id: SOURCE_KEY, sourceKey: SOURCE_KEY, active: false } as CollectionDoc,
    ],
  });
  const result = await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW });
  assert.equal(result.ok, true);
  const after = store.products?.[0] as CollectionDoc;
  assert.equal(after.alibabaSourceStatus, 'removed');
  assert.equal((after.alibabaCatalogPricing as { mode?: string }).mode, 'unavailable');
  assert.equal(after.unitPrice, 12.5, 'legacy pricing untouched');
  assert.equal(after.published, true, 'publication state untouched');
});

test('the sync NEVER self-pins: a re-price moves the storefront to the cheaper offer', async () => {
  // Two active offers; run 1 picks the cheaper. If the run's own selection fed
  // back in as a pin, run 2 would keep the now-expensive offer forever.
  setup({
    alibabaSupplierOffers: [
      offerDoc('o-a', SOURCE_KEY, 'sku-a', 100),
      offerDoc('o-b', SOURCE_KEY, 'sku-b', 900),
    ],
  });
  const first = await promoteLinkedProduct({
    sourceKey: SOURCE_KEY,
    guard: GUARD,
    now: NOW,
  });
  assert.equal(first.ok, true);
  assert.equal(
    (store.products?.[0] as CollectionDoc).alibabaPrimaryOfferKey,
    'o-a',
    'cheapest wins first',
  );

  // Supplier inverts the prices; BOTH offers stay active.
  store.alibabaSupplierOffers = [
    offerDoc('o-a', SOURCE_KEY, 'sku-a', 900),
    offerDoc('o-b', SOURCE_KEY, 'sku-b', 100),
  ];
  const second = await promoteLinkedProduct({
    sourceKey: SOURCE_KEY,
    guard: GUARD,
    now: NOW,
  });
  assert.equal(second.ok, true);
  const product = store.products?.[0] as CollectionDoc;
  assert.equal(product.alibabaPrimaryOfferKey, 'o-b', 'total order re-evaluates every run');
  assert.equal(
    (product.alibabaCatalogPricing as { amountMinor?: number })?.amountMinor,
    100,
    'the storefront follows the cheaper offer',
  );
});

test('an OPERATOR pin holds against the total order, and clears', async () => {
  setup({
    alibabaSupplierOffers: [
      offerDoc('o-a', SOURCE_KEY, 'sku-a', 100),
      offerDoc('o-b', SOURCE_KEY, 'sku-b', 900),
    ],
  });
  const pinned = await setPinnedOffer({ productId: 'p-1', offerKey: 'o-b', now: NOW });
  assert.equal(pinned.ok, true);

  await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW });
  assert.equal(
    (store.products?.[0] as CollectionDoc).alibabaPrimaryOfferKey,
    'o-b',
    'the operator pin beats the cheaper offer',
  );

  const cleared = await setPinnedOffer({ productId: 'p-1', offerKey: '', now: NOW });
  assert.equal(cleared.ok, true);
  await promoteLinkedProduct({ sourceKey: SOURCE_KEY, guard: GUARD, now: NOW });
  assert.equal(
    (store.products?.[0] as CollectionDoc).alibabaPrimaryOfferKey,
    'o-a',
    'clearing hands selection back to the total order',
  );
});

test('a pin is refused unless the offer is ACTIVE and belongs to this product', async () => {
  setup({
    alibabaSupplierOffers: [
      offerDoc('o-a', SOURCE_KEY, 'sku-a', 100),
      { ...offerDoc('o-dead', SOURCE_KEY, 'sku-c', 50), active: false } as CollectionDoc,
      offerDoc('o-other', 'other-source', 'sku-x', 10),
    ],
  });
  assert.deepEqual(await setPinnedOffer({ productId: 'p-1', offerKey: 'o-dead', now: NOW }), {
    ok: false,
    reason: 'offer-not-active',
  });
  assert.deepEqual(await setPinnedOffer({ productId: 'p-1', offerKey: 'o-other', now: NOW }), {
    ok: false,
    reason: 'offer-not-found',
  });
  assert.deepEqual(await setPinnedOffer({ productId: 'p-1', offerKey: 'nope', now: NOW }), {
    ok: false,
    reason: 'offer-not-found',
  });
});
