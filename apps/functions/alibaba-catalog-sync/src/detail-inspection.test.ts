import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdapterListQuery, AlibabaLeaseGrant, DbAdapter } from '@vibelingan-channel/db';
import {
  setAdapter,
  transitionAlibabaLeaseAcquire,
  transitionAlibabaLeaseRelease,
} from '@vibelingan-channel/db';
import {
  type MediaStorageAdapter,
  type PutMediaObjectInput,
  objectStoragePath,
  setMediaStorage,
} from '@vibelingan-channel/media-storage';
import type { CollectionDoc, ListResult } from '@vibelingan-channel/shared';
import { inspectAlibabaProductDetail } from './detail-inspection.ts';
import { syncSelectedAlibabaProduct } from './selected-sync.ts';

const NOW = '2026-09-04T04:00:00.000Z';

class InspectionAdapter implements DbAdapter {
  readonly store: Record<string, CollectionDoc[]> = {};

  private docs(collection: string): CollectionDoc[] {
    const existing = this.store[collection];
    if (existing) return existing;
    const created: CollectionDoc[] = [];
    this.store[collection] = created;
    return created;
  }

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    const items = this.docs(query.collection);
    return { items: [...items], total: items.length, page: 1, pageSize: query.pageSize };
  }

  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.docs(collection).find((doc) => doc._id === id) ?? null;
  }

  async findByField(): Promise<CollectionDoc | null> {
    return null;
  }

  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    const doc = { _id: `created-${this.docs(collection).length + 1}`, ...data } as CollectionDoc;
    this.docs(collection).push(doc);
    return doc;
  }

  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((doc) => doc._id === id);
    if (index < 0) return null;
    docs[index] = { ...docs[index], ...data } as CollectionDoc;
    return docs[index] ?? null;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const docs = this.docs(collection);
    const index = docs.findIndex((doc) => doc._id === id);
    if (index < 0) return false;
    docs.splice(index, 1);
    return true;
  }

  async incrementField(): Promise<number | null> {
    return null;
  }

  async createDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<'created' | 'exists'> {
    const docs = this.docs(collection);
    if (docs.some((doc) => doc._id === id)) return 'exists';
    docs.push({ _id: id, ...data } as CollectionDoc);
    return 'created';
  }

  async upsertDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc> {
    const current = await this.get(collection, id);
    if (current) return (await this.update(collection, id, data)) as CollectionDoc;
    await this.createDocWithId(collection, id, data);
    return (await this.get(collection, id)) as CollectionDoc;
  }

  async upsertDocWithAlibabaLease(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    createOnly: Record<string, unknown>,
  ): Promise<boolean> {
    const current = await this.get(collection, id);
    if (current) await this.update(collection, id, patch);
    else await this.createDocWithId(collection, id, { ...createOnly, ...patch });
    return true;
  }

  async updateDocWithAlibabaLease(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    return (await this.update(collection, id, patch)) !== null;
  }

  async acquireAlibabaSyncLease(
    connectionId: string,
    holder: string,
    now: string,
    ttlMs: number,
  ): Promise<AlibabaLeaseGrant> {
    const current = await this.get('alibabaSyncLeases', connectionId);
    const transition = transitionAlibabaLeaseAcquire(current, holder, now, ttlMs);
    if (transition.result !== 'granted') return transition;
    const docs = this.docs('alibabaSyncLeases');
    const next = { _id: connectionId, ...transition.doc } as CollectionDoc;
    const index = docs.findIndex((doc) => doc._id === connectionId);
    if (index < 0) docs.push(next);
    else docs[index] = next;
    return { result: 'granted', fence: transition.fence };
  }

  async releaseAlibabaSyncLease(
    connectionId: string,
    holder: string,
    fence: number,
    now: string,
  ): Promise<boolean> {
    const current = await this.get('alibabaSyncLeases', connectionId);
    const transition = transitionAlibabaLeaseRelease(current, holder, fence, now);
    if (transition.result !== 'applied') return false;
    await this.update('alibabaSyncLeases', connectionId, transition.patch);
    return true;
  }
}

class InspectionStorage implements MediaStorageAdapter {
  readonly puts: PutMediaObjectInput[] = [];

  async putObject(input: PutMediaObjectInput) {
    this.puts.push(input);
    const storagePath = objectStoragePath(input);
    return {
      storageProvider: 'local-disk' as const,
      storageMode: 'local-disk' as const,
      storageFileId: `mem://${storagePath}`,
      storagePath,
    };
  }

  async getObjectAsBase64(): Promise<{ body: string }> {
    throw new Error('not used');
  }

  async getTempUrl(): Promise<{ url: string }> {
    throw new Error('not used');
  }

  async deleteObject(): Promise<void> {
    throw new Error('not used');
  }

  async getUploadCredential(): Promise<never> {
    throw new Error('not used');
  }
}

function liveDetailBody(productId = 'AAGmBBhgAOVTpOOZBg7MoZq_'): string {
  return JSON.stringify({
    alibaba_icbu_product_get_response: {
      product: {
        product_id: productId,
        subject: 'Sensitive supplier title',
        description: '<div>Private supplier description</div>',
        category_id: 123,
        status: 'published',
        main_image: {
          images: { string: ['https://sc04.alicdn.com/private-image.jpg'] },
        },
        sourcing_trade: {
          fob_currency: 'USD',
          fob_min_price: '12.34',
          fob_max_price: '56.78',
          min_order_quantity: '3',
        },
        product_sku: {
          sku_attributes: {
            sku_attribute: [
              {
                attribute_id: 19089,
                attribute_name: 'Connectors',
                values: {
                  sku_attribute_value: [{ value_id: 3236313, system_value_name: '3.5 mm' }],
                },
              },
            ],
          },
          skus: {
            sku_definition: [
              {
                sku_id: 29581034890,
                attr2_value: '{"19089":3236313}',
                price: '12.34',
                bulk_discount_prices: {
                  bulk_discount_price: [
                    { start_quantity: 500, price: '11.50' },
                    { start_quantity: 1000, price: '10.90' },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
}

test('one-product inspection uses TOP product.get, stores raw evidence, and returns only structure', async () => {
  const adapter = new InspectionAdapter();
  const storage = new InspectionStorage();
  setAdapter(adapter);
  setMediaStorage(storage);
  const calls: Record<string, unknown>[] = [];

  const result = await inspectAlibabaProductDetail({
    sourceProductId: 'AAGmBBhgAOVTpOOZBg7MoZq_',
    deps: {
      now: () => NOW,
      getAccessToken: async () => ({ ok: true, accessToken: 'secret-access-token' }),
      client: {
        fingerprintFor: () => 'safe-fingerprint',
        callApi: async (input) => {
          calls.push(input as unknown as Record<string, unknown>);
          return { ok: true, status: 200, bodyText: liveDetailBody() };
        },
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.summary.sourceProductId, 'AAGmBBhgAOVTpOOZBg7MoZq_');
  assert.equal(result.summary.rawByteLength, Buffer.byteLength(liveDetailBody(), 'utf8'));
  assert.equal(result.summary.description.kind, 'html');
  assert.equal(result.summary.description.characterCount, 39);
  assert.equal(result.summary.imageCount, 1);
  assert.equal(result.summary.skuCount, 1);
  assert.equal(result.summary.skusWithAttributes, 1);
  assert.deepEqual(result.summary.attributeNames, ['Connectors']);
  assert.equal(result.summary.skuTieredPriceCount, 1);
  assert.equal(result.summary.currency, 'USD');

  assert.deepEqual(calls[0], {
    apiPath: 'alibaba.icbu.product.get',
    protocol: 'top',
    params: { product_id: 'AAGmBBhgAOVTpOOZBg7MoZq_', language: 'ENGLISH' },
    accessToken: 'secret-access-token',
    timeoutMs: 5_000,
    maxAttempts: 1,
  });
  assert.equal(storage.puts.length, 1, 'the exact provider response is persisted first');
  assert.equal(adapter.store.alibabaSourcePayloads?.length, 1);
  assert.equal(
    adapter.store.alibabaSourceProducts,
    undefined,
    'inspection never mutates the mirror',
  );
  assert.equal(adapter.store.alibabaSupplierOffers, undefined, 'inspection never mutates offers');
  assert.notEqual(adapter.store.alibabaSyncLeases?.[0]?.releasedAt, '', 'lease is released');

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('secret-access-token'));
  assert.ok(!serialized.includes('Private supplier description'));
  assert.ok(!serialized.includes('private-image.jpg'));
});

test('one-product inspection rejects mismatched ids after preserving the raw response', async () => {
  const adapter = new InspectionAdapter();
  const storage = new InspectionStorage();
  setAdapter(adapter);
  setMediaStorage(storage);

  const result = await inspectAlibabaProductDetail({
    sourceProductId: 'requested-product',
    deps: {
      now: () => NOW,
      getAccessToken: async () => ({ ok: true, accessToken: 'token' }),
      client: {
        fingerprintFor: () => 'safe-fingerprint',
        callApi: async () => ({
          ok: true,
          status: 200,
          bodyText: liveDetailBody('different-product'),
        }),
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'product-id-mismatch',
    payloadId: adapter.store.alibabaSourcePayloads?.[0]?._id,
  });
  assert.equal(storage.puts.length, 1);
  assert.equal(adapter.store.alibabaSourceProducts, undefined);
});

test('one-product inspection validates ids before taking the lease or calling Alibaba', async () => {
  const adapter = new InspectionAdapter();
  const storage = new InspectionStorage();
  setAdapter(adapter);
  setMediaStorage(storage);
  let providerCalls = 0;

  const result = await inspectAlibabaProductDetail({
    sourceProductId: '../not-a-product-id',
    deps: {
      now: () => NOW,
      getAccessToken: async () => ({ ok: true, accessToken: 'token' }),
      client: {
        fingerprintFor: () => 'unused',
        callApi: async () => {
          providerCalls += 1;
          return { ok: true, status: 200, bodyText: liveDetailBody() };
        },
      },
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'invalid-product-id' });
  assert.equal(providerCalls, 0);
  assert.equal(adapter.store.alibabaSyncLeases, undefined);
});

test('selected product sync ingests detail and creates one unpublished visible draft', async () => {
  const adapter = new InspectionAdapter();
  const storage = new InspectionStorage();
  setAdapter(adapter);
  setMediaStorage(storage);

  const result = await syncSelectedAlibabaProduct({
    sourceProductId: 'AAGmBBhgAOVTpOOZBg7MoZq_',
    deps: {
      now: () => NOW,
      getAccessToken: async () => ({ ok: true, accessToken: 'secret-access-token' }),
      client: {
        fingerprintFor: () => 'safe-fingerprint',
        callApi: async () => ({ ok: true, status: 200, bodyText: liveDetailBody() }),
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draftCreated, true);
  assert.equal(result.offerCount, 1);
  const product = adapter.store.products?.find((candidate) => candidate._id === result.productId);
  assert.ok(product);
  assert.equal(product.published, false);
  assert.equal(product.archived, false);
  assert.equal(product.name, 'Sensitive supplier title');
  assert.equal(product.description, 'Private supplier description');
  assert.equal(product.alibabaSourceProductId, 'AAGmBBhgAOVTpOOZBg7MoZq_');
  assert.equal((product.alibabaCatalogPricing as { mode?: string })?.mode, 'tiered');
  assert.equal(adapter.store.alibabaSourceProducts?.length, 1);
  assert.equal(adapter.store.catalogSourceObservations?.length, 1);
  assert.equal(adapter.store.alibabaProductLinks?.length, 1);
  assert.notEqual(adapter.store.alibabaSyncLeases?.[0]?.releasedAt, '');
});
