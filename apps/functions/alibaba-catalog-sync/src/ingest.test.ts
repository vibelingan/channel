import { strict as assert } from 'node:assert';
import test from 'node:test';
import { alibabaOfferKey, alibabaSourceKey } from '@vibelingan-channel/alibaba-catalog-sync';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import {
  type MediaStorageAdapter,
  type PutMediaObjectInput,
  objectStoragePath,
  setMediaStorage,
} from '@vibelingan-channel/media-storage';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { ingestProductDetail, storeRawPayload } from './ingest.ts';

// --- harness (memory db + memory storage) -----------------------------------

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
  async findByField(
    collection: string,
    field: string,
    value: unknown,
  ): Promise<CollectionDoc | null> {
    return this.docs(collection).find((d) => d[field] === value) ?? null;
  }
  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    const doc = { _id: `mem-${this.nextId++}`, ...data } as CollectionDoc;
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

class MemoryMediaStorage implements MediaStorageAdapter {
  readonly puts: PutMediaObjectInput[] = [];
  failNextPut = false;
  async putObject(input: PutMediaObjectInput) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('simulated storage outage');
    }
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
  async deleteObject(): Promise<void> {}
  async getUploadCredential(): Promise<never> {
    throw new Error('not used');
  }
}

let store: Store = {};
let storage = new MemoryMediaStorage();
function setup(): void {
  store = {};
  storage = new MemoryMediaStorage();
  setAdapter(new MemoryAdapter(store));
  setMediaStorage(storage);
}

const NOW = '2026-08-06T10:00:00.000Z';

const detailBody = (skus: { id: string; price: number }[]) =>
  JSON.stringify({
    result: {
      product: {
        product_id: 987,
        subject: 'Headphones',
        fob_currency: 'USD',
        sku_infos: skus.map((sku) => ({ sku_id: sku.id, price: sku.price })),
      },
    },
  });

const ingest = (body: string, runId = 'run-1') =>
  ingestProductDetail({
    bodyText: body,
    endpointId: 'product.get',
    requestFingerprint: 'fp-1',
    connectionId: 'primary',
    runId,
    now: NOW,
  });

// --- raw payload evidence ----------------------------------------------------

test('raw payload is hash-addressed, deduplicated, and metadata-rowed by hash', async () => {
  setup();
  const first = await storeRawPayload({
    bodyText: '{"a":1}',
    endpointId: 'e',
    requestFingerprint: 'fp',
    connectionId: 'primary',
    runId: 'run-1',
    now: NOW,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.deduplicated, false);
  assert.match(first.responseSha256, /^[0-9a-f]{64}$/);
  assert.equal(store.alibabaSourcePayloads?.length, 1);
  assert.equal(store.alibabaSourcePayloads?.[0]?._id, first.responseSha256);
  assert.ok(storage.puts[0]);
  assert.equal(storage.puts[0].namespace, 'alibaba-raw');
  assert.equal(
    objectStoragePath(storage.puts[0]),
    `alibaba-raw/${first.responseSha256.slice(0, 2)}/${first.responseSha256}.json`,
  );

  const second = await storeRawPayload({
    bodyText: '{"a":1}',
    endpointId: 'e',
    requestFingerprint: 'fp',
    connectionId: 'primary',
    runId: 'run-2',
    now: NOW,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.deduplicated, true);
  assert.equal(store.alibabaSourcePayloads?.length, 1, 'one metadata row per hash');
  assert.equal(storage.puts.length, 1, 'one object per hash');
});

test('raw bytes are durable BEFORE parsing: malformed bodies still leave evidence', async () => {
  setup();
  const result = await ingest('<html>gateway error</html>');
  assert.deepEqual(result, { ok: false, error: 'malformed-response' });
  assert.equal(store.alibabaSourcePayloads?.length, 1, 'raw evidence exists');
  assert.equal(store.alibabaSourceProducts?.length ?? 0, 0, 'no mirror write');
});

test('a raw-write failure aborts the page with nothing else written', async () => {
  setup();
  storage.failNextPut = true;
  const result = await ingest(detailBody([{ id: 'sku-1', price: 2.5 }]));
  assert.deepEqual(result, { ok: false, error: 'raw-write-failed' });
  assert.equal(store.alibabaSourcePayloads?.length ?? 0, 0);
  assert.equal(store.alibabaSourceProducts?.length ?? 0, 0);
  assert.equal(store.alibabaSupplierOffers?.length ?? 0, 0);
});

// --- normalization + idempotency --------------------------------------------

test('ingest mirrors source product and offers with deterministic ids; rerun converges', async () => {
  setup();
  const body = detailBody([{ id: 'sku-1', price: 2.5 }]);
  const first = await ingest(body, 'run-1');
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const sourceKey = alibabaSourceKey('primary', '987');
  assert.equal(first.sourceKey, sourceKey);
  assert.equal(store.alibabaSourceProducts?.length, 1);
  const product = store.alibabaSourceProducts?.[0];
  assert.equal(product?._id, sourceKey);
  assert.equal(product?.firstSeenRunId, 'run-1');
  assert.equal(product?.lastSeenRunId, 'run-1');
  assert.equal(product?.active, true);
  assert.equal(store.alibabaSupplierOffers?.length, 1);
  assert.equal(store.alibabaSupplierOffers?.[0]?._id, alibabaOfferKey('primary', '987', 'sku-1'));

  // Rerun on a later run: same documents, provenance preserved, stamps advance.
  const second = await ingest(body, 'run-2');
  assert.equal(second.ok, true);
  assert.equal(store.alibabaSourceProducts?.length, 1, 'no duplicate mirror rows');
  assert.equal(store.alibabaSupplierOffers?.length, 1, 'no duplicate offers');
  assert.equal(store.alibabaSourceProducts?.[0]?.firstSeenRunId, 'run-1', 'first-seen preserved');
  assert.equal(store.alibabaSourceProducts?.[0]?.lastSeenRunId, 'run-2');
});

test('a SKU that disappears from the detail deactivates its mirror offer', async () => {
  setup();
  await ingest(
    detailBody([
      { id: 'sku-1', price: 2.5 },
      { id: 'sku-2', price: 3.5 },
    ]),
    'run-1',
  );
  assert.equal(store.alibabaSupplierOffers?.length, 2);

  const result = await ingest(detailBody([{ id: 'sku-1', price: 2.4 }]), 'run-2');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.deactivatedOfferKeys, [alibabaOfferKey('primary', '987', 'sku-2')]);
  const sku2 = store.alibabaSupplierOffers?.find(
    (offer) => offer._id === alibabaOfferKey('primary', '987', 'sku-2'),
  );
  assert.equal(sku2?.active, false);
  const sku1 = store.alibabaSupplierOffers?.find(
    (offer) => offer._id === alibabaOfferKey('primary', '987', 'sku-1'),
  );
  assert.equal(sku1?.active, true);
  assert.equal((sku1?.pricing as { amountMinor?: number })?.amountMinor, 240);
});

test('api-error envelopes keep raw evidence and report the failure', async () => {
  setup();
  const result = await ingest(JSON.stringify({ error_code: 'AppCallLimit' }));
  assert.deepEqual(result, { ok: false, error: 'api-error' });
  assert.equal(store.alibabaSourcePayloads?.length, 1);
});

const BODY = detailBody([{ id: 'sku-1', price: 2.5 }]);

test('content fingerprint ignores wall-clock stamps: a re-ingest is NOT a change', async () => {
  // The surge guard counts CHANGED candidates. The normalizer stamps
  // fetchedAt/syncedAt with the caller's clock on every ingest, so a
  // fingerprint that included them made every re-ingest look changed and the
  // guard tripped on every full run. The existing tests all pass one frozen
  // NOW, which is precisely why that shipped — this one varies the clock.
  setup();
  const first = await ingestProductDetail({
    bodyText: BODY,
    endpointId: 'product.get',
    requestFingerprint: 'fp-1',
    connectionId: 'primary',
    runId: 'run-1',
    now: NOW,
  });
  assert.equal(first.ok, true);
  const afterFirst = store.alibabaSourceProducts?.[0] as CollectionDoc;
  const hashAfterFirst = afterFirst.contentHash;
  assert.equal(afterFirst.lastChangedRunId, 'run-1');
  assert.ok(typeof hashAfterFirst === 'string' && hashAfterFirst.length === 64);

  // Same bytes, LATER clock, different run.
  const second = await ingestProductDetail({
    bodyText: BODY,
    endpointId: 'product.get',
    requestFingerprint: 'fp-2',
    connectionId: 'primary',
    runId: 'run-2',
    now: '2026-08-06T18:30:00.000Z',
  });
  assert.equal(second.ok, true);
  const afterSecond = store.alibabaSourceProducts?.[0] as CollectionDoc;
  assert.equal(afterSecond.contentHash, hashAfterFirst, 'identical content, identical hash');
  assert.equal(
    afterSecond.lastChangedRunId,
    'run-1',
    'an unchanged re-ingest must NOT advance the change stamp',
  );
  assert.equal(afterSecond.lastSeenRunId, 'run-2', 'but it IS seen by the new run');
});

test('a per-response id from the gateway is NOT a content change', async () => {
  // Real gateways stamp a request id or server timestamp into each response.
  // That changes the raw bytes, hence payloadId (their sha256) — but the
  // PRODUCT is identical. If payloadId counted, the change stamp would move on
  // every call and the surge guard would trip on every full run again.
  setup();
  const withId = (id: string) =>
    JSON.stringify({
      request_id: id,
      result: {
        product: {
          product_id: 987,
          subject: 'Headphones',
          fob_currency: 'USD',
          sku_infos: [{ sku_id: 'sku-1', price: 2.5 }],
        },
      },
    });

  await ingestProductDetail({
    bodyText: withId('req-aaa'),
    endpointId: 'product.get',
    requestFingerprint: 'fp-1',
    connectionId: 'primary',
    runId: 'run-1',
    now: NOW,
  });
  const first = store.alibabaSourceProducts?.[0] as CollectionDoc;

  await ingestProductDetail({
    bodyText: withId('req-bbb'),
    endpointId: 'product.get',
    requestFingerprint: 'fp-2',
    connectionId: 'primary',
    runId: 'run-2',
    now: '2026-08-06T18:30:00.000Z',
  });
  const second = store.alibabaSourceProducts?.[0] as CollectionDoc;

  assert.notEqual(first.payloadId, second.payloadId, 'the raw bytes DID differ');
  assert.equal(second.contentHash, first.contentHash, 'but the product did not');
  assert.equal(second.lastChangedRunId, 'run-1', 'so the change stamp holds');
});

test('a real content change DOES advance the change stamp', async () => {
  setup();
  await ingestProductDetail({
    bodyText: BODY,
    endpointId: 'product.get',
    requestFingerprint: 'fp-1',
    connectionId: 'primary',
    runId: 'run-1',
    now: NOW,
  });
  const changedBody = detailBody([{ id: 'sku-1', price: 9.9 }]);
  const second = await ingestProductDetail({
    bodyText: changedBody,
    endpointId: 'product.get',
    requestFingerprint: 'fp-2',
    connectionId: 'primary',
    runId: 'run-2',
    now: '2026-08-06T18:30:00.000Z',
  });
  assert.equal(second.ok, true);
  assert.equal(
    (store.alibabaSourceProducts?.[0] as CollectionDoc).lastChangedRunId,
    'run-2',
    'a price move is a real change',
  );
});
