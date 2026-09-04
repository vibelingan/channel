import { strict as assert } from 'node:assert';
import test from 'node:test';
import { alibabaSourceKey } from '@vibelingan-channel/alibaba-catalog-sync';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import {
  createDraftForSource,
  draftProductId,
  linkExistingProduct,
  unlinkProduct,
} from './linking.ts';

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  private nextId = 1;
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
  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    const doc = { _id: `auto-${this.nextId++}`, ...data } as CollectionDoc;
    this.docs(collection).push(doc);
    return doc;
  }
  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return null;
    docs[index] = { ...(docs[index] as CollectionDoc), ...data };
    return docs[index] as CollectionDoc;
  }
  async remove(collection: string, id: string): Promise<boolean> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return false;
    docs.splice(index, 1);
    return true;
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
  async createDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<'created' | 'exists'> {
    const docs = this.docs(collection);
    if (docs.some((d) => d._id === id)) return 'exists';
    const { _id, ...payload } = data as Record<string, unknown> & { _id?: unknown };
    docs.push({ _id: id, ...payload } as CollectionDoc);
    return 'created';
  }
  async upsertDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    const { _id, ...patch } = data as Record<string, unknown> & { _id?: unknown };
    if (index >= 0) {
      docs[index] = { ...(docs[index] as CollectionDoc), ...patch };
      return docs[index] as CollectionDoc;
    }
    const created = { _id: id, ...patch } as CollectionDoc;
    docs.push(created);
    return created;
  }
}

const NOW = '2026-08-06T11:00:00.000Z';
const CTX = { now: NOW, userId: 'admin-1' };
const SOURCE_KEY = alibabaSourceKey('primary', '987');

const SOURCE_OBSERVATION: CollectionDoc = {
  _id: sourceObservationDocumentId('alibaba', SOURCE_KEY),
  provider: 'alibaba',
  sourceProductKey: SOURCE_KEY,
  observation: {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: SOURCE_KEY,
      externalProductId: '987',
      observedAt: NOW,
      sourceUpdatedAt: '2026-08-05T10:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: {
      title: 'Observed BT Headphones',
      matchHints: {},
      category: {
        sourceTaxonomy: 'alibaba:icbu',
        sourceCategoryId: 'cat-100',
        sourceCategoryName: 'Consumer Electronics > Headphones',
      },
      attributes: [],
    },
    content: {
      description: {
        text: 'Observed description',
        placeholder: false,
        sanitized: true,
        provenance: 'provider-description',
      },
      media: [{ sourceUrl: 'https://sc04.alicdn.com/product.jpg', role: 'primary', position: 0 }],
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [
      {
        sourceVariantKey: 'variant-black',
        externalVariantId: 'sku-black',
        options: [
          { sourceName: 'color', value: 'Black' },
          { sourceName: 'model number', value: 'WH-3' },
        ],
        inventory: [{ quantity: 50, semantics: 'sellable' }],
        media: [],
      },
      {
        sourceVariantKey: 'variant-white',
        externalVariantId: 'sku-white',
        options: [
          { sourceName: 'Color', value: 'White' },
          { sourceName: 'Model No.', value: 'WH-3' },
        ],
        inventory: [],
        media: [],
      },
    ],
    offers: [
      {
        sourceOfferKey: 'offer-black',
        sourceVariantKey: 'variant-black',
        externalVariantId: 'sku-black',
        kind: 'supplier',
        pricing: {
          mode: 'tiered',
          currency: 'USD',
          minimumOrderQuantity: 10,
          tiers: [
            { minimumQuantity: 10, maximumQuantity: 99, unitAmountMinor: 515 },
            { minimumQuantity: 100, unitAmountMinor: 357 },
          ],
        },
      },
      {
        sourceOfferKey: 'offer-white',
        sourceVariantKey: 'variant-white',
        externalVariantId: 'sku-white',
        kind: 'supplier',
        pricing: { mode: 'unavailable', minimumOrderQuantity: 20 },
      },
    ],
    evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64), sha256: 'a'.repeat(64) }],
    warnings: [],
  },
} as CollectionDoc;

let store: Store = {};
function setup(extra: Store = {}): Store {
  store = {
    alibabaSourceProducts: [
      {
        _id: SOURCE_KEY,
        sourceKey: SOURCE_KEY,
        connectionId: 'primary',
        sourceProductId: '987',
        sourceTitle: 'BT Headphones',
        sourceDescription: 'desc',
        sourceCategoryId: 'cat-100',
        sourceImageUrls: ['https://sc04.alicdn.com/product.jpg'],
        active: true,
      } as CollectionDoc,
    ],
    products: [
      {
        _id: 'p-1',
        name: 'Legacy',
        productFamily: 'headphones',
        category: 'wired',
        slug: 'legacy-headset',
        skuCode: 'HP-LEGACY-1',
        imageIds: ['img-1'],
        unitPrice: 12.5,
        published: true,
        archived: false,
      } as CollectionDoc,
    ],
    catalogSourceObservations: [SOURCE_OBSERVATION],
    ...extra,
  };
  setAdapter(new MemoryAdapter(store));
  return store;
}

// --- explicit link -----------------------------------------------------------

test('explicit link claims the source and stamps only Alibaba-owned fields', async () => {
  setup();
  const result = await linkExistingProduct(SOURCE_KEY, 'p-1', CTX);
  assert.deepEqual(result, {
    ok: true,
    sourceKey: SOURCE_KEY,
    productId: 'p-1',
    alreadyLinked: false,
  });
  const link = store.alibabaProductLinks?.[0];
  assert.equal(link?._id, SOURCE_KEY);
  assert.equal(link?.productId, 'p-1');
  assert.equal(link?.linkedByUserId, 'admin-1');
  const product = store.products?.[0];
  assert.equal(product?.alibabaPrimarySourceKey, SOURCE_KEY);
  assert.equal(product?.alibabaSourceProductId, '987');
  assert.equal(product?.alibabaSourceCategoryId, 'cat-100');
  assert.deepEqual(product?.alibabaSourceImageUrls, ['https://sc04.alicdn.com/product.jpg']);
  assert.equal(product?.alibabaSourceStatus, 'available');
  // Legacy and curated surfaces untouched.
  assert.equal(product?.unitPrice, 12.5);
  assert.equal(product?.published, true);
  assert.equal(product?.name, 'Legacy');
  assert.equal(product?.productFamily, 'headphones');
  assert.equal(product?.category, 'wired');
  assert.equal(product?.slug, 'legacy-headset');
  assert.equal(product?.skuCode, 'HP-LEGACY-1');
  assert.deepEqual(product?.imageIds, ['img-1']);
  assert.equal(product?.archived, false);
});

test('RACE: one source product can never link to two Channel products', async () => {
  setup({
    products: [
      { _id: 'p-1', name: 'A', category: 'wired' } as CollectionDoc,
      { _id: 'p-2', name: 'B', category: 'wired' } as CollectionDoc,
    ],
  });
  const results = await Promise.all([
    linkExistingProduct(SOURCE_KEY, 'p-1', CTX),
    linkExistingProduct(SOURCE_KEY, 'p-2', CTX),
  ]);
  const wins = results.filter((r) => r.ok && !r.alreadyLinked);
  const conflicts = results.filter((r) => !r.ok && r.reason === 'source-linked-elsewhere');
  assert.equal(wins.length, 1, 'exactly one winner');
  assert.equal(conflicts.length, 1, 'loser sees the conflict');
  assert.equal(store.alibabaProductLinks?.length, 1);
});

test('re-linking the same pair is idempotent; unknown ids are rejected', async () => {
  setup();
  await linkExistingProduct(SOURCE_KEY, 'p-1', CTX);
  const again = await linkExistingProduct(SOURCE_KEY, 'p-1', CTX);
  assert.deepEqual(again, {
    ok: true,
    sourceKey: SOURCE_KEY,
    productId: 'p-1',
    alreadyLinked: true,
  });
  assert.deepEqual(await linkExistingProduct('missing-key', 'p-1', CTX), {
    ok: false,
    reason: 'source-not-found',
  });
  assert.deepEqual(await linkExistingProduct(SOURCE_KEY, 'missing-product', CTX), {
    ok: false,
    reason: 'product-not-found',
  });
});

// --- unlink ------------------------------------------------------------------

test('unlink clears ONLY Alibaba fields and removes link rows (legacy path restored)', async () => {
  setup();
  await linkExistingProduct(SOURCE_KEY, 'p-1', CTX);
  const result = await unlinkProduct('p-1', CTX);
  assert.deepEqual(result, { ok: true, productId: 'p-1', clearedLinks: 1 });
  assert.equal(store.alibabaProductLinks?.length, 0);
  const product = store.products?.[0];
  assert.equal(product?.alibabaPrimarySourceKey, null);
  assert.equal(product?.alibabaCatalogPricing, null);
  assert.equal(product?.alibabaSourceStatus, null);
  assert.equal(product?.alibabaSourceReview, null);
  // Legacy pricing byte-identical — nothing was destroyed.
  assert.equal(product?.unitPrice, 12.5);
  assert.equal(product?.published, true);
  assert.equal(product?.productFamily, 'headphones');
  assert.equal(product?.category, 'wired');
  assert.equal(product?.slug, 'legacy-headset');
  assert.equal(product?.skuCode, 'HP-LEGACY-1');
  assert.deepEqual(product?.imageIds, ['img-1']);
  assert.equal(product?.archived, false);
  assert.deepEqual(await unlinkProduct('missing', CTX), { ok: false, reason: 'product-not-found' });
});

// --- draft creation ----------------------------------------------------------

const MAPPING: CollectionDoc = {
  _id: 'map-1',
  alibabaCategoryId: 'cat-100',
  channelCategory: 'bluetooth',
} as CollectionDoc;

test('an unmapped source still creates a visible unpublished draft', async () => {
  setup();
  const result = await createDraftForSource(SOURCE_KEY, CTX);
  assert.deepEqual(result, { ok: true, productId: draftProductId(SOURCE_KEY), created: true });
  const draft = store.products?.find((product) => product._id === draftProductId(SOURCE_KEY));
  assert.ok(draft);
  assert.equal(draft.published, false);
  assert.equal(draft.archived, false);
  assert.equal(draft.productFamily, undefined, 'unmapped source remains uncategorized');
  assert.equal(draft.category, undefined, 'no category is invented');
  assert.equal(draft.alibabaSourceProductId, '987');
  assert.equal(draft.alibabaSourceCategoryId, 'cat-100');
  assert.deepEqual(draft.alibabaSourceImageUrls, ['https://sc04.alicdn.com/product.jpg']);
  assert.equal(draft.alibabaReviewPending, true);
});

test('a mapped source creates an UNPUBLISHED draft with source suggestions', async () => {
  setup({ alibabaCategoryMappings: [MAPPING] });
  const result = await createDraftForSource(SOURCE_KEY, CTX);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.created, true);
  const draft = store.products?.find((p) => p._id === result.productId);
  assert.ok(draft);
  assert.equal(draft.published, false, 'worker-created drafts are never published');
  assert.equal(draft.name, 'Observed BT Headphones');
  assert.equal(draft.category, 'bluetooth');
  assert.equal(draft.productFamily, 'headphones');
  assert.equal(draft.slug, undefined, 'worker never invents public identity');
  assert.equal(draft.skuCode, undefined, 'worker never invents operator SKU identity');
  assert.equal(draft.alibabaPrimarySourceKey, SOURCE_KEY);
  assert.equal(draft.imageIds, undefined, 'no automatic public image selection');
  assert.deepEqual(draft.alibabaSourceReview, {
    schemaVersion: 'alibaba-source-review-v1',
    provider: 'alibaba',
    externalProductId: '987',
    sourceCategoryId: 'cat-100',
    sourceCategoryName: 'Consumer Electronics > Headphones',
    sourceUpdatedAt: '2026-08-05T10:00:00.000Z',
    sourceListingStatus: 'published',
    variantCount: 2,
    offerCount: 2,
    modelNumbers: ['WH-3'],
    optionNames: ['color', 'model number'],
    minimumOrderQuantity: 10,
    primaryPricing: {
      mode: 'tiered',
      currency: 'USD',
      minimumOrderQuantity: 10,
      tiers: [
        { minimumQuantity: 10, maximumQuantity: 99, unitAmountMinor: 515 },
        { minimumQuantity: 100, unitAmountMinor: 357 },
      ],
    },
  });
  const link = store.alibabaProductLinks?.[0];
  assert.equal(link?.productId, result.productId);
});

test('RACE: concurrent draft creation converges on one product', async () => {
  setup({ alibabaCategoryMappings: [MAPPING] });
  const [a, b] = await Promise.all([
    createDraftForSource(SOURCE_KEY, CTX),
    createDraftForSource(SOURCE_KEY, CTX),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // Exactly one link row and one deterministic draft exist; retries cannot
  // create an orphan product.
  assert.equal(store.alibabaProductLinks?.length, 1);
  assert.equal(store.products?.filter((product) => product._id !== 'p-1').length, 1);
  const linked = store.alibabaProductLinks?.[0]?.productId;
  assert.ok(linked);
  if (a.ok && b.ok) {
    assert.equal(a.productId, linked);
    assert.equal(b.productId, linked);
  }
});

test('a crashed claim (empty productId) is repaired on retry', async () => {
  setup({
    alibabaCategoryMappings: [MAPPING],
    alibabaProductLinks: [
      {
        _id: SOURCE_KEY,
        sourceKey: SOURCE_KEY,
        connectionId: 'primary',
        sourceProductId: '987',
        productId: '',
        linkedAt: NOW,
      } as CollectionDoc,
    ],
  });
  const result = await createDraftForSource(SOURCE_KEY, CTX);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.created, true);
  assert.equal(store.alibabaProductLinks?.[0]?.productId, result.productId);
});

test('an existing complete link returns the linked product without creating', async () => {
  setup({ alibabaCategoryMappings: [MAPPING] });
  await linkExistingProduct(SOURCE_KEY, 'p-1', CTX);
  const result = await createDraftForSource(SOURCE_KEY, CTX);
  assert.deepEqual(result, { ok: true, productId: 'p-1', created: false });
  assert.equal(store.products?.length, 1, 'no draft for an already-linked source');
  assert.equal(store.products?.[0]?.alibabaReviewPending, true, 'legacy linked row is backfilled');
  assert.equal(
    (store.products?.[0]?.alibabaSourceReview as { variantCount?: number }).variantCount,
    2,
    'the current source review is refreshed without another product.get call',
  );
});

test('a later category mapping backfills an existing generated draft without overwriting review edits', async () => {
  setup();
  const first = await createDraftForSource(SOURCE_KEY, CTX);
  assert.equal(first.ok, true);
  const draft = store.products?.find((product) => product._id === draftProductId(SOURCE_KEY));
  assert.ok(draft);
  draft.name = 'Operator edited name';
  draft.description = 'Operator edited description';
  store.sourceCategoryMappings = [
    {
      _id: 'common-map-1',
      provider: 'alibaba',
      sourceTaxonomy: 'alibaba:icbu',
      sourceCategoryId: 'cat-100',
      productFamily: 'headphones',
      channelCategory: 'bluetooth',
    } as CollectionDoc,
  ];

  const second = await createDraftForSource(SOURCE_KEY, {
    now: '2026-08-07T00:00:00.000Z',
  });

  assert.deepEqual(second, { ok: true, productId: draftProductId(SOURCE_KEY), created: false });
  const refreshed = store.products?.find((product) => product._id === draftProductId(SOURCE_KEY));
  assert.equal(refreshed?.productFamily, 'headphones');
  assert.equal(refreshed?.category, 'bluetooth');
  assert.equal(refreshed?.name, 'Operator edited name');
  assert.equal(refreshed?.description, 'Operator edited description');
  assert.equal(refreshed?.published, false);
});

test('draft retry never reopens a product an admin already reviewed', async () => {
  setup({ alibabaCategoryMappings: [MAPPING] });
  await linkExistingProduct(SOURCE_KEY, 'p-1', CTX);
  const product = store.products?.[0];
  assert.ok(product);
  product.alibabaReviewPending = false;
  product.alibabaReviewedAt = NOW;
  product.alibabaReviewedByUserId = 'admin-1';

  const result = await createDraftForSource(SOURCE_KEY, {
    now: '2026-08-07T00:00:00.000Z',
  });

  assert.deepEqual(result, { ok: true, productId: 'p-1', created: false });
  assert.equal(product.alibabaReviewPending, false);
  assert.equal(product.alibabaReviewedAt, NOW);
  assert.equal(product.alibabaReviewedByUserId, 'admin-1');
});
