import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type AlibabaClient,
  DEFAULT_ALIBABA_ENDPOINTS,
  alibabaSourceKey,
  computeCandidateHash,
  createAlibabaClient,
  initialEnumerationState,
} from '@vibelingan-channel/alibaba-catalog-sync';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type {
  AdapterListQuery,
  AlibabaLeaseGrant,
  AlibabaLeaseGuard,
  AlibabaSyncRunClaimResult,
  DbAdapter,
} from '@vibelingan-channel/db';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  holdsAlibabaLease,
  setAdapter,
  transitionAlibabaLeaseAcquire,
  transitionAlibabaLeaseRelease,
  transitionAlibabaLeaseRenew,
} from '@vibelingan-channel/db';
import {
  type AlibabaProductLinkIdentity,
  type AlibabaProductMutationInput,
  type AlibabaProductMutationResult,
  runAlibabaProductMutation,
} from '@vibelingan-channel/db/adapter';
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
import { linkExistingProduct, unlinkProduct } from './linking.ts';
import { promoteLinkedProduct } from './promotion.ts';
import { approveQuarantinedRun } from './quarantine.ts';
import { runSyncTick } from './runner.ts';

// --- full-surface memory adapter --------------------------------------------

type Store = Record<string, CollectionDoc[]>;

class RunnerMemoryAdapter implements DbAdapter {
  private nextId = 1;
  private mutationQueue = Promise.resolve();
  constructor(readonly store: Store) {}
  async mutateAlibabaProduct(
    input: AlibabaProductMutationInput,
  ): Promise<AlibabaProductMutationResult> {
    const operation = this.mutationQueue.then(async () => {
      const copy = structuredClone(this.store);
      const result = await runAlibabaProductMutation(
        {
          get: async (collection, id) =>
            structuredClone(copy[collection]?.find((row) => row._id === id) ?? null),
          set: async (collection, row) => {
            copy[collection] ??= [];
            const rows = copy[collection];
            const index = rows.findIndex((existing) => existing._id === row._id);
            if (index < 0) rows.push(structuredClone(row));
            else rows[index] = structuredClone(row);
          },
          remove: async (collection, id) => {
            copy[collection] = (copy[collection] ?? []).filter((row) => row._id !== id);
          },
        },
        (copy.alibabaProductLinks ?? []).filter((row) => row.productId === input.productId),
        input,
      );
      if (result.ok) Object.assign(this.store, copy);
      return result;
    });
    this.mutationQueue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
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
  async incrementField(
    collection: string,
    id: string,
    field: string,
    delta: number,
  ): Promise<number | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return null;
    const next = Number((docs[index] as CollectionDoc)[field] ?? 0) + delta;
    docs[index] = { ...(docs[index] as CollectionDoc), [field]: next };
    return next;
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
  async acquireAlibabaSyncLease(
    connectionId: string,
    holder: string,
    now: string,
    ttlMs: number,
  ): Promise<AlibabaLeaseGrant> {
    const docs = this.docs('alibabaSyncLeases');
    const index = docs.findIndex((d) => d._id === connectionId);
    const transition = transitionAlibabaLeaseAcquire(
      index >= 0 ? (docs[index] as CollectionDoc) : null,
      holder,
      now,
      ttlMs,
    );
    if (transition.result !== 'granted') return { result: transition.result };
    const next = { _id: connectionId, ...transition.doc } as CollectionDoc;
    if (index >= 0) docs[index] = next;
    else docs.push(next);
    return { result: 'granted', fence: transition.fence };
  }
  async renewAlibabaSyncLease(
    connectionId: string,
    holder: string,
    fence: number,
    now: string,
    ttlMs: number,
  ): Promise<boolean> {
    const docs = this.docs('alibabaSyncLeases');
    const index = docs.findIndex((d) => d._id === connectionId);
    const existing = index >= 0 ? (docs[index] as CollectionDoc) : null;
    const transition = transitionAlibabaLeaseRenew(existing, holder, fence, now, ttlMs);
    if (transition.result !== 'applied') return false;
    docs[index] = { ...(existing as CollectionDoc), ...transition.patch };
    return true;
  }
  async releaseAlibabaSyncLease(
    connectionId: string,
    holder: string,
    fence: number,
    now: string,
  ): Promise<boolean> {
    const docs = this.docs('alibabaSyncLeases');
    const index = docs.findIndex((d) => d._id === connectionId);
    const existing = index >= 0 ? (docs[index] as CollectionDoc) : null;
    const transition = transitionAlibabaLeaseRelease(existing, holder, fence, now);
    if (transition.result !== 'applied') return false;
    if (Object.keys(transition.patch).length > 0) {
      docs[index] = { ...(existing as CollectionDoc), ...transition.patch };
    }
    return true;
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
  async upsertDocWithAlibabaLease(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    createOnly: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<boolean> {
    const lease = this.docs('alibabaSyncLeases').find((d) => d._id === guard.connectionId) ?? null;
    if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return false;
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index >= 0) docs[index] = { ...(docs[index] as CollectionDoc), ...patch };
    else docs.push({ _id: id, ...createOnly, ...patch } as CollectionDoc);
    return true;
  }
  async claimAlibabaSyncRun(
    runId: string,
    run: Record<string, unknown>,
    checkpointPatch: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<AlibabaSyncRunClaimResult> {
    const lease = this.docs('alibabaSyncLeases').find((d) => d._id === guard.connectionId) ?? null;
    if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return 'lease-lost';
    const checkpoints = this.docs('alibabaSyncCheckpoints');
    const checkpointIndex = checkpoints.findIndex((d) => d._id === guard.connectionId);
    if (checkpointIndex < 0) return 'checkpoint-missing';
    const checkpoint = checkpoints[checkpointIndex] as CollectionDoc;
    if (checkpoint.activeRunId !== undefined && checkpoint.activeRunId !== '') {
      return 'checkpoint-busy';
    }
    const runs = this.docs('alibabaSyncRuns');
    if (runs.some((d) => d._id === runId)) return 'run-exists';
    const { _id: _runId, ...safeRun } = run as Record<string, unknown> & { _id?: unknown };
    const { _id: _checkpointId, ...safeCheckpointPatch } = checkpointPatch as Record<
      string,
      unknown
    > & { _id?: unknown };
    runs.push({ _id: runId, ...safeRun } as CollectionDoc);
    checkpoints[checkpointIndex] = { ...checkpoint, ...safeCheckpointPatch } as CollectionDoc;
    return 'claimed';
  }
}

class MemoryMediaStorage implements MediaStorageAdapter {
  async putObject(input: PutMediaObjectInput) {
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

// --- fake Alibaba backend ----------------------------------------------------

interface FakeItem {
  id: string;
  modifiedMs: number;
  priceLexeme: string;
  removed?: boolean;
}

/** Signed-client-compatible fetch backed by a synthetic catalog. */
function fakeBackend(items: () => FakeItem[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(url));
    const params = new URLSearchParams(String(init?.body ?? ''));
    const method = params.get('method') ?? '';
    calls.push(`${requestUrl.pathname}:${method}`);
    if (requestUrl.pathname === '/sync' && method === 'alibaba.icbu.product.list') {
      const fromTop = (value: string | null, fallback: number): number =>
        value ? Date.parse(`${value.replace(' ', 'T')}+08:00`) : fallback;
      const from = fromTop(params.get('gmt_modified_from'), 0);
      const to = fromTop(params.get('gmt_modified_to'), Date.parse('2100-01-01T00:00:00Z'));
      const inWindow = items().filter(
        (item) => !item.removed && item.modifiedMs >= from && item.modifiedMs <= to,
      );
      const pageSize = Number(params.get('page_size') ?? '30');
      return new Response(
        JSON.stringify({
          result: {
            total_item: inWindow.length,
            products: inWindow.slice(0, pageSize).map((item) => ({ product_id: item.id })),
          },
        }),
        { status: 200 },
      );
    }
    if (requestUrl.pathname === '/sync' && method === 'alibaba.icbu.product.get') {
      const id = params.get('product_id') ?? '';
      const item = items().find((candidate) => candidate.id === id);
      if (!item || item.removed) {
        return new Response(JSON.stringify({ error_code: 'ProductNotFound' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          result: {
            product: {
              product_id: item.id,
              subject: `Item ${item.id}`,
              fob_currency: 'USD',
              sku_infos: [{ sku_id: 'sku-1', price: item.priceLexeme }],
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// --- harness -----------------------------------------------------------------

const T0 = '2026-08-06T12:16:00.000Z'; // just past the 12:15 incremental boundary
function productLink(
  sourceProductId: string,
  overrides: Partial<AlibabaProductLinkIdentity> = {},
): CollectionDoc & AlibabaProductLinkIdentity {
  const sourceKey = alibabaSourceKey('primary', sourceProductId);
  return {
    _id: sourceKey,
    sourceKey,
    connectionId: 'primary',
    sourceProductId,
    productId: 'p-1',
    linkedAt: T0,
    ...overrides,
  };
}

let clockMs = Date.parse(T0);
const now = () => new Date(clockMs).toISOString();

let store: Store = {};
const alerts: string[] = [];

function makeDeps(fetchImpl: typeof fetch): Parameters<typeof runSyncTick>[0]['deps'] {
  const client: AlibabaClient = createAlibabaClient({
    appKey: '511630',
    appSecret: 'secret',
    endpoints: DEFAULT_ALIBABA_ENDPOINTS,
    fetchImpl,
    sleep: () => Promise.resolve(),
    now: () => clockMs,
  });
  return {
    client,
    getAccessToken: async () => ({ ok: true as const, accessToken: 'live-token' }),
    now,
    alert: async (message: string) => {
      alerts.push(message);
    },
  };
}

function setup(extra: Store = {}): Store {
  clockMs = Date.parse(T0);
  alerts.length = 0;
  store = {
    // Incremental due in the past (12:15 boundary), full due far in the future.
    alibabaSyncCheckpoints: [
      {
        _id: 'primary',
        connectionId: 'primary',
        activeRunId: '',
        stage: 'enumerate',
        nextFullDueAt: '2026-08-09T18:30:00.000Z',
        nextIncrementalDueAt: '2026-08-06T12:15:00.000Z',
        committedCursor: '2026-08-06T08:15:00.000Z',
        continuationCount: 0,
      } as CollectionDoc,
    ],
    ...extra,
  };
  setAdapter(new RunnerMemoryAdapter(store));
  setMediaStorage(new MemoryMediaStorage());
  return store;
}

const ITEM_TIME = Date.parse('2026-08-06T10:00:00.000Z'); // inside the window

// --- tests -------------------------------------------------------------------

test('the first successful sync materializes source pricing on a new draft without waiting for another source update', async () => {
  setup();
  const backend = fakeBackend(() => [
    { id: 'new-item', modifiedMs: ITEM_TIME, priceLexeme: '5.70' },
  ]);
  const report = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'manual' });
  assert.equal(report.outcome, 'completed');
  const product = store.products?.[0];
  assert.ok(product);
  assert.equal(product.published, false);
  assert.equal(
    product.unitPrice,
    undefined,
    'source price is not copied into website scalar price',
  );
  assert.equal(
    (product.alibabaCatalogPricing as { amountMinor?: number } | undefined)?.amountMinor,
    570,
  );
});

test('incremental tick: enumerates the window, ingests, promotes linked, advances the cursor', async () => {
  setup();
  const sourceKey = alibabaSourceKey('primary', 'item-1');
  store.alibabaProductLinks = [productLink('item-1')];
  store.products = [
    {
      _id: 'p-1',
      name: 'Curated',
      category: 'bluetooth',
      unitPrice: 12.5,
      alibabaPrimarySourceKey: sourceKey,
    } as CollectionDoc,
  ];
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);

  const report = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'timer' });
  assert.equal(report.outcome, 'completed', JSON.stringify(report));

  assert.ok(
    backend.calls.includes('/sync:alibaba.icbu.product.list'),
    'Alibaba ICBU list uses the TOP /sync transport',
  );
  assert.ok(
    backend.calls.includes('/sync:alibaba.icbu.product.get'),
    'Alibaba ICBU detail uses the TOP /sync transport',
  );

  // Mirror + offers ingested with raw evidence.
  assert.ok((store.alibabaSourceProducts?.length ?? 0) >= 1);
  assert.ok((store.alibabaSourcePayloads?.length ?? 0) >= 2, 'list + detail raw payloads');
  // Linked product promoted through the fenced write.
  const product = store.products?.[0] as CollectionDoc;
  assert.equal((product.alibabaCatalogPricing as { amountMinor?: number })?.amountMinor, 250);
  assert.equal(product.unitPrice, 12.5, 'legacy pricing untouched');
  // Run + checkpoint bookkeeping.
  const run = store.alibabaSyncRuns?.[0] as CollectionDoc;
  assert.equal(run.status, 'completed');
  const checkpoint = store.alibabaSyncCheckpoints?.[0] as CollectionDoc;
  assert.equal(checkpoint.activeRunId, '');
  assert.equal(checkpoint.committedCursor, T0, 'cursor = window end, only at completion');
  assert.equal(checkpoint.nextIncrementalDueAt, '2026-08-06T16:15:00.000Z', 'due from schedule');
  // Lease released at exit.
  const lease = store.alibabaSyncLeases?.[0] as CollectionDoc;
  assert.notEqual(lease.releasedAt, '');
});

test('idle tick: nothing due -> no runs, no API calls, lease released', async () => {
  setup();
  const checkpoints = store.alibabaSyncCheckpoints as CollectionDoc[];
  checkpoints[0] = {
    ...(checkpoints[0] as CollectionDoc),
    nextIncrementalDueAt: '2026-08-06T16:15:00.000Z',
  };
  const backend = fakeBackend(() => []);
  const report = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'timer' });
  assert.equal(report.outcome, 'idle');
  assert.equal(backend.calls.length, 0);
  assert.equal(store.alibabaSyncRuns, undefined);
});

test('duplicate timer delivery: the lease admits exactly one concurrent tick', async () => {
  setup();
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);
  const deps = makeDeps(backend.fetchImpl);
  const [a, b] = await Promise.all([
    runSyncTick({ deps, trigger: 'timer' }),
    runSyncTick({ deps, trigger: 'timer' }),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['completed', 'lease-busy']);
  assert.equal(store.alibabaSyncRuns?.length, 1, 'exactly one run row');
});

test('lease takeover before the atomic run claim creates no run and claims no checkpoint', async () => {
  setup();
  const backend = fakeBackend(() => []);
  const deps = makeDeps(backend.fetchImpl);
  deps.getAccessToken = async () => {
    const lease = store.alibabaSyncLeases?.[0] as CollectionDoc;
    store.alibabaSyncLeases = [
      {
        ...lease,
        holder: 'new-holder',
        fence: Number(lease.fence) + 1,
        expiresAt: '2026-08-06T12:30:00.000Z',
        releasedAt: '',
      } as CollectionDoc,
    ];
    return { ok: true as const, accessToken: 'live-token' };
  };

  const report = await runSyncTick({ deps, trigger: 'timer' });
  assert.equal(report.outcome, 'lease-lost');
  assert.equal(store.alibabaSyncRuns?.length ?? 0, 0, 'stale holder creates no orphan run');
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId,
    '',
    'stale holder cannot claim the shared checkpoint',
  );
});

test('token resolution that crosses the lease TTL cannot claim a run with stale time', async () => {
  setup();
  const backend = fakeBackend(() => []);
  const deps = makeDeps(backend.fetchImpl);
  deps.getAccessToken = async () => {
    clockMs += ALIBABA_SYNC_LEASE_TTL_MS + 1;
    return { ok: true as const, accessToken: 'late-token' };
  };

  const report = await runSyncTick({ deps, trigger: 'timer' });
  assert.equal(report.outcome, 'lease-lost');
  assert.equal(store.alibabaSyncRuns?.length ?? 0, 0, 'expired holder creates no orphan run');
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId,
    '',
    'expired holder cannot claim the shared checkpoint',
  );
  assert.equal(backend.calls.length, 0, 'no Alibaba data call starts under the expired lease');
});

test('checkpoint race before the atomic run claim creates no orphan run', async () => {
  setup();
  const backend = fakeBackend(() => []);
  const deps = makeDeps(backend.fetchImpl);
  deps.getAccessToken = async () => {
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId = 'other-run';
    return { ok: true as const, accessToken: 'live-token' };
  };

  const report = await runSyncTick({ deps, trigger: 'timer' });
  assert.deepEqual(report, { outcome: 'lease-busy', detail: 'checkpoint-claim-race' });
  assert.equal(store.alibabaSyncRuns?.length ?? 0, 0, 'loser creates no orphan run');
  assert.equal((store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId, 'other-run');
});

test('continuation: an exhausted budget checkpoints durably and the next tick completes', async () => {
  setup();
  const backend = fakeBackend(() => [
    { id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '1.00' },
    { id: 'item-2', modifiedMs: ITEM_TIME + 1000, priceLexeme: '2.00' },
  ]);
  const deps = makeDeps(backend.fetchImpl);
  // First slice: bounded so tightly it cannot finish enumeration.
  const first = await runSyncTick({
    deps,
    trigger: 'timer',
    budgetOverrides: { maxApiCalls: 2 },
  });
  assert.equal(first.outcome, 'continued');
  const checkpoint = store.alibabaSyncCheckpoints?.[0] as CollectionDoc;
  assert.notEqual(checkpoint.activeRunId, '', 'run stays active');

  clockMs += 15 * 60_000; // next tick
  const second = await runSyncTick({ deps, trigger: 'timer' });
  assert.equal(second.outcome, 'completed', JSON.stringify(second));
  assert.equal(store.alibabaSourceProducts?.length ?? 0, 2, 'both items ingested');
  const run = store.alibabaSyncRuns?.[0] as CollectionDoc;
  assert.equal(run.status, 'completed');
  assert.equal((store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId, '');
});

test('a transient page error is cleared after the resumed run succeeds', async () => {
  setup();
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);
  let failListOnce = true;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    if (failListOnce && params.get('method') === 'alibaba.icbu.product.list') {
      failListOnce = false;
      return new Response(
        JSON.stringify({
          error_response: {
            code: '15',
            type: 'ISP',
            msg: 'Remote service error',
          },
        }),
        { status: 200 },
      );
    }
    return backend.fetchImpl(url, init);
  }) as typeof fetch;
  const deps = makeDeps(fetchImpl);

  const first = await runSyncTick({ deps, trigger: 'timer' });
  assert.equal(first.outcome, 'continued');
  assert.equal(
    (store.alibabaSyncRuns?.[0] as CollectionDoc).errorSummary,
    'page-failure:api-error',
  );

  clockMs += 15 * 60_000;
  const second = await runSyncTick({ deps, trigger: 'timer' });
  assert.equal(second.outcome, 'completed', JSON.stringify(second));
  const run = store.alibabaSyncRuns?.[0] as CollectionDoc;
  assert.equal(run.status, 'completed');
  assert.equal(
    run.errorSummary,
    '',
    'recovered transient error must not remain in the Errors column',
  );
});

test('a token failure at start leaves NO phantom run and NO claimed slot', async () => {
  setup();
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);
  const deps = {
    ...makeDeps(backend.fetchImpl),
    getAccessToken: async () => ({ ok: false as const, reason: 'not-connected' }),
  };

  // An incremental run IS due, so the tick gets past decideTick — the token
  // must be resolved before anything is written.
  const report = await runSyncTick({ deps, trigger: 'timer' });
  assert.deepEqual(report, { outcome: 'not-connected', detail: 'not-connected' });
  assert.equal(backend.calls.length, 0, 'no API calls');
  assert.equal(store.alibabaSyncRuns?.length ?? 0, 0, 'no phantom run row');
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId,
    '',
    'slot never claimed — a dead credential cannot wedge sync for 24h',
  );
  assert.equal(alerts.length, 0, 'no spurious run-overdue alert');

  // Ticking 100 more times (past RUN_MAX_CONTINUATIONS) still leaves no trace.
  for (let i = 0; i < 100; i += 1) {
    clockMs += 15 * 60_000;
    await runSyncTick({ deps, trigger: 'timer' });
  }
  assert.equal(store.alibabaSyncRuns?.length ?? 0, 0, 'still no run rows');
  assert.equal(alerts.length, 0, 'still no alerts');

  // The connection recovers: the very next due tick runs normally.
  clockMs = Date.parse(T0);
  const recovered = await runSyncTick({
    deps: makeDeps(
      fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]).fetchImpl,
    ),
    trigger: 'timer',
  });
  assert.equal(recovered.outcome, 'completed');
});

test('a token failure while RESUMING keeps the run intact and burns no continuation', async () => {
  setup();
  const checkpoint = store.alibabaSyncCheckpoints?.[0] as CollectionDoc;
  checkpoint.activeRunId = 'run-live';
  checkpoint.continuationCount = 3;
  checkpoint.enumerationState = initialEnumerationState({
    fromMs: Date.parse('2026-08-06T08:15:00.000Z'),
    toMs: Date.parse('2026-08-06T12:00:00.000Z'),
  });
  store.alibabaSyncRuns = [
    {
      _id: 'run-live',
      status: 'running',
      mode: 'incremental',
      startedAt: '2026-08-06T12:00:00.000Z',
    } as CollectionDoc,
  ];

  const backend = fakeBackend(() => []);
  const report = await runSyncTick({
    deps: {
      ...makeDeps(backend.fetchImpl),
      getAccessToken: async () => ({ ok: false as const, reason: 'refresh-unavailable' }),
    },
    trigger: 'timer',
  });
  assert.deepEqual(report, { outcome: 'not-connected', detail: 'refresh-unavailable' });
  assert.equal((store.alibabaSyncRuns?.[0] as CollectionDoc).status, 'running', 'run untouched');
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).continuationCount,
    3,
    'no continuation burned by a tick that did no work',
  );
  assert.equal((store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId, 'run-live');
});

test('a manual run MARKS ITSELF DUE — the timer-less test env can still sync', async () => {
  setup();
  // Nothing is due: push both watermarks into the future.
  const checkpoint = store.alibabaSyncCheckpoints?.[0] as CollectionDoc;
  checkpoint.nextIncrementalDueAt = '2026-08-09T00:00:00.000Z';
  checkpoint.nextFullDueAt = '2026-08-09T18:30:00.000Z';

  const timerTick = await runSyncTick({
    deps: makeDeps(fakeBackend(() => []).fetchImpl),
    trigger: 'timer',
  });
  assert.equal(timerTick.outcome, 'idle', 'a timer tick respects the schedule');

  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);
  const manual = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'manual' });
  assert.notEqual(manual.outcome, 'idle', 'a manual run starts one regardless');
  assert.ok(backend.calls.length > 0, 'it actually reached the API');
});

test('a manual start is incremental even when the stored full watermark is overdue', async () => {
  setup();
  const checkpoint = store.alibabaSyncCheckpoints?.[0] as CollectionDoc;
  checkpoint.nextFullDueAt = '2026-08-02T18:30:00.000Z';
  checkpoint.nextIncrementalDueAt = '2026-08-09T00:00:00.000Z';

  const report = await runSyncTick({
    deps: makeDeps(fakeBackend(() => []).fetchImpl),
    trigger: 'manual',
  });

  assert.equal(report.outcome, 'completed');
  assert.equal(store.alibabaSyncRuns?.[0]?.mode, 'incremental');
  assert.equal(
    checkpoint.nextFullDueAt,
    '2026-08-02T18:30:00.000Z',
    'manual incremental does not silently advance or consume the full schedule',
  );
});

test('drafts are created only AFTER the quarantine gate passes', async () => {
  setup();
  // An unlinked source with a category mapping would normally become a draft.
  store.alibabaCategoryMappings = [
    { _id: 'm-1', sourceCategoryId: '77', category: 'bluetooth' } as CollectionDoc,
  ];
  // Sabotage the detail response so the run quarantines on unsupported currency.
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);
  const originalFetch = backend.fetchImpl;
  const sabotaged = (async (url: unknown, init?: RequestInit) => {
    const response = await originalFetch(String(url), init);
    const text = await response.text();
    return new Response(text.replace('"USD"', '"EUR"'), { status: 200 });
  }) as typeof fetch;

  const report = await runSyncTick({ deps: makeDeps(sabotaged), trigger: 'timer' });
  assert.equal(report.outcome, 'quarantined');
  assert.equal(
    store.products?.length ?? 0,
    0,
    'a quarantined run writes NO product rows — nothing would ever roll them back',
  );
  assert.equal(store.alibabaProductLinks?.length ?? 0, 0, 'and no links');
});

test('self-heal: a terminal run stuck in the checkpoint slot is cleared, not resumed', async () => {
  setup();
  const checkpoint = store.alibabaSyncCheckpoints?.[0] as CollectionDoc;
  checkpoint.activeRunId = 'run-done';
  checkpoint.windowEnd = '2026-08-06T12:00:00.000Z';
  checkpoint.committedCursor = '2026-08-06T08:15:00.000Z';
  store.alibabaSyncRuns = [
    {
      _id: 'run-done',
      status: 'completed',
      mode: 'incremental',
      startedAt: '2026-08-06T11:00:00.000Z',
    } as CollectionDoc,
  ];

  const backend = fakeBackend(() => []);
  const report = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'timer' });
  assert.equal(report.outcome, 'idle');
  assert.equal(report.detail, 'stale-active-run-cleared');
  assert.equal(backend.calls.length, 0, 'no API calls to resume a finished run');
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId,
    '',
    'slot vacated',
  );
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).committedCursor,
    '2026-08-06T12:00:00.000Z',
    'a completed run whose clear was interrupted still commits its durable window end',
  );
  assert.equal((store.alibabaSyncRuns?.[0] as CollectionDoc).status, 'completed', 'run untouched');
});

test('overdue run: failed AND the slot is vacated so the next tick starts fresh', async () => {
  setup();
  const checkpoint = store.alibabaSyncCheckpoints?.[0] as CollectionDoc;
  checkpoint.activeRunId = 'run-stuck';
  checkpoint.enumerationState = initialEnumerationState({
    fromMs: Date.parse('2026-08-06T08:15:00.000Z'),
    toMs: Date.parse('2026-08-06T12:00:00.000Z'),
  });
  store.alibabaSyncRuns = [
    {
      _id: 'run-stuck',
      status: 'running',
      mode: 'incremental',
      // Two days old — far past the max run age.
      startedAt: '2026-08-04T12:00:00.000Z',
    } as CollectionDoc,
  ];

  const backend = fakeBackend(() => []);
  const report = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'timer' });
  assert.equal(report.outcome, 'failed');
  assert.equal(report.detail, 'run-overdue');
  assert.equal((store.alibabaSyncRuns?.[0] as CollectionDoc).status, 'failed');
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId,
    '',
    'slot vacated — sync can never wedge on a dead run',
  );

  // The NEXT tick is free to start the due incremental run.
  const next = await runSyncTick({
    deps: makeDeps(fakeBackend(() => []).fetchImpl),
    trigger: 'timer',
  });
  assert.notEqual(next.outcome, 'lease-busy');
  assert.notEqual(next.runId, 'run-stuck');
});

test('unsupported currency quarantines BEFORE promotion; approval promotes the frozen candidate', async () => {
  setup();
  const sourceKey = alibabaSourceKey('primary', 'item-1');
  store.alibabaProductLinks = [productLink('item-1')];
  store.products = [
    {
      _id: 'p-1',
      name: 'Curated',
      category: 'bluetooth',
      unitPrice: 12.5,
      alibabaPrimarySourceKey: sourceKey,
    } as CollectionDoc,
  ];
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);
  // Sabotage: the detail returns EUR pricing -> unsupported currency.
  const originalFetch = backend.fetchImpl;
  const sabotaged = (async (url: unknown, init?: RequestInit) => {
    const response = await originalFetch(String(url), init);
    const text = await response.text();
    return new Response(text.replace('"USD"', '"EUR"'), { status: 200 });
  }) as typeof fetch;

  const report = await runSyncTick({ deps: makeDeps(sabotaged), trigger: 'timer' });
  assert.equal(report.outcome, 'quarantined');
  const product = store.products?.[0] as CollectionDoc;
  assert.equal(product.alibabaCatalogPricing, undefined, 'NO promotion before approval');
  const run = store.alibabaSyncRuns?.[0] as CollectionDoc;
  assert.equal(run.status, 'quarantined');
  assert.ok(typeof run.candidateHash === 'string' && run.candidateHash.length === 64);
  assert.equal(
    (store.alibabaSyncCheckpoints?.[0] as CollectionDoc).activeRunId,
    '',
    'slot vacated',
  );
  assert.ok(alerts.some((message) => message.includes('quarantined')));

  // Approval with the WRONG hash is rejected; the right hash promotes.
  const wrong = await approveQuarantinedRun({
    runId: String(run._id),
    candidateHash: 'f'.repeat(64),
    approvedByUserId: 'admin-1',
    now,
    alert: async (m) => {
      alerts.push(m);
    },
  });
  assert.deepEqual(wrong, { ok: false, reason: 'superseded' });
  // The RECOMPUTE arm of the supersession check: a later run that touched the
  // mirror must invalidate the frozen candidate set even when the operator
  // submits the run's OWN recorded hash. (Reducing the check to the operator
  // arm alone previously left the whole suite green.)
  const mirrorRow = store.alibabaSourceProducts?.[0] as CollectionDoc;
  const originalSeen = mirrorRow.lastSeenRunId;
  mirrorRow.lastSeenRunId = 'a-later-run';
  const superseded = await approveQuarantinedRun({
    runId: String(run._id),
    candidateHash: String(run.candidateHash),
    approvedByUserId: 'admin-1',
    now,
    alert: async (m) => {
      alerts.push(m);
    },
  });
  assert.deepEqual(superseded, { ok: false, reason: 'superseded' }, 'a moved mirror invalidates');
  mirrorRow.lastSeenRunId = originalSeen;

  const approved = await approveQuarantinedRun({
    runId: String(run._id),
    candidateHash: String(run.candidateHash),
    approvedByUserId: 'admin-1',
    now,
    alert: async (m) => {
      alerts.push(m);
    },
  });
  assert.equal(approved.ok, true);
  assert.equal((store.alibabaSyncRuns?.[0] as CollectionDoc).status, 'approved');
  // The frozen candidate (unavailable pricing — EUR degraded) is now applied.
  const promotedProduct = store.products?.[0] as CollectionDoc;
  assert.equal((promotedProduct.alibabaCatalogPricing as { mode?: string })?.mode, 'unavailable');
  assert.equal(promotedProduct.unitPrice, 12.5, 'legacy untouched throughout');
});

async function quarantineLinkedProducts(count = 1, products?: CollectionDoc[]) {
  setup();
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index + 1}`,
    modifiedMs: ITEM_TIME,
    priceLexeme: '2.50',
  }));
  store.alibabaProductLinks = items.map((item, index) =>
    productLink(item.id, { productId: `p-${index + 1}` }),
  );
  store.products =
    products ??
    items.map((item, index) => ({
      _id: `p-${index + 1}`,
      name: 'Curated',
      unitPrice: 12.5,
      alibabaPrimarySourceKey: alibabaSourceKey('primary', item.id),
    }));
  const backend = fakeBackend(() => items);
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await backend.fetchImpl(url, init);
    return new Response((await response.text()).replace('"USD"', '"EUR"'), { status: 200 });
  };
  const report = await runSyncTick({ deps: makeDeps(fetchImpl), trigger: 'timer' });
  assert.equal(report.outcome, 'quarantined');
  const run = store.alibabaSyncRuns?.[0];
  assert.ok(run);
  assert.equal(typeof run.candidateHash, 'string');
  alerts.length = 0;
  return { runId: run._id, candidateHash: String(run.candidateHash) };
}

for (const order of ['A-first', 'B-first']) {
  for (const relinkSecondary of [false, true]) {
    test(`R1: multi-source quarantine ${order} ${relinkSecondary ? 'rejects secondary relink' : 'promotes only frozen primary'}`, async (context) => {
      setup();
      const secondaryKey = alibabaSourceKey('primary', 'item-a');
      const primaryKey = alibabaSourceKey('primary', 'item-b');
      const sourceOrder =
        order === 'A-first' ? [secondaryKey, primaryKey] : [primaryKey, secondaryKey];
      store.alibabaProductLinks = [productLink('item-a'), productLink('item-b')];
      store.products = [
        {
          _id: 'p-1',
          name: 'Curated',
          unitPrice: 12.5,
          alibabaPrimarySourceKey: primaryKey,
          alibabaLinkRevision: 7,
        },
      ];
      const adapter = new RunnerMemoryAdapter(store);
      setAdapter(adapter);
      const list = adapter.list.bind(adapter);
      context.mock.method(adapter, 'list', async (query: AdapterListQuery) => {
        const result = await list(query);
        if (query.collection === 'alibabaSourceProducts') {
          result.items.sort(
            (left, right) => sourceOrder.indexOf(left._id) - sourceOrder.indexOf(right._id),
          );
        }
        return result;
      });
      const backend = fakeBackend(() => [
        { id: 'item-a', modifiedMs: ITEM_TIME, priceLexeme: '1.50' },
        { id: 'item-b', modifiedMs: ITEM_TIME, priceLexeme: '2.50' },
      ]);
      const fetchImpl: typeof fetch = async (url, init) => {
        const response = await backend.fetchImpl(url, init);
        return new Response((await response.text()).replace('"USD"', '"EUR"'), { status: 200 });
      };
      assert.equal(
        (await runSyncTick({ deps: makeDeps(fetchImpl), trigger: 'timer' })).outcome,
        'quarantined',
      );
      const run = store.alibabaSyncRuns?.[0];
      assert.ok(run);
      assert.equal(typeof run.candidateHash, 'string');
      const frozenLinks = structuredClone(store.alibabaProductLinks);
      if (relinkSecondary) {
        const secondary = store.alibabaProductLinks?.find((link) => link._id === secondaryKey);
        assert.ok(secondary);
        secondary.productId = 'p-2';
        store.products?.push({ _id: 'p-2', alibabaPrimarySourceKey: secondaryKey });
      }
      const before = structuredClone(store.products);
      const attempts: Extract<AlibabaProductMutationInput, { action: 'promote' }>[] = [];
      const mutate = adapter.mutateAlibabaProduct.bind(adapter);
      context.mock.method(
        adapter,
        'mutateAlibabaProduct',
        async (input: AlibabaProductMutationInput) => {
          if (input.action === 'promote') attempts.push(structuredClone(input));
          return mutate(input);
        },
      );
      alerts.length = 0;
      const result = await approveQuarantinedRun({
        runId: run._id,
        candidateHash: String(run.candidateHash),
        approvedByUserId: 'admin-1',
        now,
        alert: async (message) => {
          alerts.push(message);
        },
      });
      if (relinkSecondary) {
        assert.deepEqual(result, { ok: false, reason: 'superseded' });
        assert.deepEqual(store.products, before);
        assert.equal(attempts.length, 0, 'secondary membership is checked before promotion');
        assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
        assert.equal(alerts.length, 0);
      } else {
        assert.deepEqual(result, { ok: true, runId: run._id, promoted: 1 });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]?.sourceKey, primaryKey);
        assert.equal(attempts[0]?.expectedRevision, 7);
        assert.equal(attempts[0]?.expectedPrimarySourceKey, primaryKey);
        assert.deepEqual(new Set(attempts[0]?.expectedLinks), new Set(frozenLinks));
        assert.equal(store.products?.[0]?.alibabaLinkRevision, 8);
        assert.equal(store.products?.[0]?.alibabaPrimarySourceKey, primaryKey);
        assert.equal(store.products?.[0]?.alibabaSourceProductId, 'item-b');
        assert.equal(store.products?.[0]?.unitPrice, 12.5);
        assert.deepEqual(store.alibabaProductLinks, frozenLinks);
        assert.equal(store.alibabaSyncRuns?.[0]?.status, 'approved');
        assert.equal(alerts.length, 1);
      }
      assert.equal(store.alibabaSyncRuns?.[0]?.candidateHash, run.candidateHash);
    });
  }
}

test('R1: quarantine success matches normal promotion and does not count unchanged products', async () => {
  const frozen = await quarantineLinkedProducts(2);
  const before = structuredClone(store);
  const approve = (input: typeof frozen) =>
    approveQuarantinedRun({
      ...input,
      approvedByUserId: 'admin-1',
      now,
      alert: async (message) => {
        alerts.push(message);
      },
    });
  assert.deepEqual(await approve(frozen), { ok: true, runId: frozen.runId, promoted: 2 });
  const approvedProducts = structuredClone(store.products);
  assert.ok(approvedProducts);
  const normal = new RunnerMemoryAdapter(before);
  setAdapter(normal);
  const grant = await normal.acquireAlibabaSyncLease(
    'primary',
    'normal-promotion',
    T0,
    ALIBABA_SYNC_LEASE_TTL_MS,
  );
  assert.equal(grant.result, 'granted');
  if (grant.result !== 'granted') assert.fail('normal promotion lease missing');
  for (const link of before.alibabaProductLinks ?? []) {
    const result = await promoteLinkedProduct({
      sourceKey: link._id,
      guard: { connectionId: 'primary', holder: 'normal-promotion', fence: grant.fence, now: T0 },
      now: T0,
    });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(before.products, approvedProducts);
  const unchanged = await quarantineLinkedProducts(2, approvedProducts);
  assert.deepEqual(await approve(unchanged), { ok: true, runId: unchanged.runId, promoted: 0 });
  assert.equal(store.alibabaSyncRuns?.[0]?.status, 'approved');
});

for (const target of ['p-2', 'p-1']) {
  for (const timing of ['before-approval', 'lease-acquisition']) {
    test(`R1: quarantine rejects unlink/relink to ${target} at ${timing}`, async () => {
      const frozen = await quarantineLinkedProducts();
      const sourceKey = alibabaSourceKey('primary', 'item-1');
      const originalLink = structuredClone(store.alibabaProductLinks?.[0]);
      if (target === 'p-2') store.products?.push({ _id: target, name: 'Other', unitPrice: 25 });
      const relink = async () => {
        assert.equal((await unlinkProduct('p-1', { now: T0 })).ok, true);
        assert.equal((await linkExistingProduct(sourceKey, target, { now: T0 })).ok, true);
        if (target === 'p-1') {
          assert.ok(originalLink);
          for (const field of [
            '_id',
            'sourceKey',
            'connectionId',
            'sourceProductId',
            'productId',
            'linkedAt',
          ]) {
            assert.equal(
              store.alibabaProductLinks?.[0]?.[field],
              originalLink[field],
              'ABA recreates the same identity and timestamp',
            );
          }
          assert.equal(store.products?.[0]?.alibabaLinkRevision, 2);
        }
      };
      if (timing === 'before-approval') await relink();
      else {
        class RelinkBeforeLeaseAdapter extends RunnerMemoryAdapter {
          override async acquireAlibabaSyncLease(
            connectionId: string,
            holder: string,
            acquiredAt: string,
            ttlMs: number,
          ): Promise<AlibabaLeaseGrant> {
            await relink();
            return super.acquireAlibabaSyncLease(connectionId, holder, acquiredAt, ttlMs);
          }
        }
        setAdapter(new RelinkBeforeLeaseAdapter(store));
      }
      const result = await approveQuarantinedRun({
        ...frozen,
        approvedByUserId: 'admin-1',
        now,
        alert: async (message) => {
          alerts.push(message);
        },
      });
      assert.deepEqual(result, { ok: false, reason: 'superseded' });
      assert.equal(
        store.products?.find((product) => product._id === target)?.alibabaCatalogPricing ?? null,
        null,
      );
      assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
      assert.equal(store.alibabaSyncRuns?.[0]?.candidateHash, frozen.candidateHash);
      assert.equal(alerts.length, 0);
    });
  }
}

test('R1: quarantine rejects legacy source-key-only hashes without upgrading approval', async () => {
  const frozen = await quarantineLinkedProducts();
  const legacyHash = computeCandidateHash({
    runId: frozen.runId,
    candidates: [{ sourceKey: alibabaSourceKey('primary', 'item-1') }],
    tombstones: [],
  });
  const run = store.alibabaSyncRuns?.[0];
  assert.ok(run);
  run.candidateHash = legacyHash;
  const before = structuredClone(store.products);
  assert.deepEqual(
    await approveQuarantinedRun({
      ...frozen,
      candidateHash: legacyHash,
      approvedByUserId: 'admin-1',
      now,
      alert: async (message) => {
        alerts.push(message);
      },
    }),
    { ok: false, reason: 'superseded' },
  );
  assert.deepEqual(store.products, before);
  assert.equal(store.alibabaSyncRuns?.[0]?.candidateHash, legacyHash);
  assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
  assert.equal(alerts.length, 0);
});

test('R1: partial quarantine promotion cannot silently rebase a retry onto newer revisions', async (context) => {
  const frozen = await quarantineLinkedProducts(2);
  const adapter = new RunnerMemoryAdapter(store);
  setAdapter(adapter);
  const mutate = adapter.mutateAlibabaProduct.bind(adapter);
  let rejected = false;
  let attempts = 0;
  context.mock.method(
    adapter,
    'mutateAlibabaProduct',
    async (input: AlibabaProductMutationInput): Promise<AlibabaProductMutationResult> => {
      if (input.action === 'promote') attempts += 1;
      if (attempts === 2 && !rejected) {
        rejected = true;
        return { ok: false, reason: 'identity-conflict' };
      }
      return mutate(input);
    },
  );
  const approve = () =>
    approveQuarantinedRun({
      ...frozen,
      approvedByUserId: 'admin-1',
      now,
      alert: async (message) => {
        alerts.push(message);
      },
    });
  assert.equal((await approve()).ok, false);
  assert.equal(rejected, true, 'the second promotion was attempted');
  assert.equal(store.products?.filter((product) => product.alibabaLinkRevision === 1).length, 1);
  assert.equal(
    store.products?.filter((product) => product.alibabaCatalogPricing === undefined).length,
    1,
  );
  const afterPartial = structuredClone(store.products);
  assert.deepEqual(await approve(), { ok: false, reason: 'superseded' });
  assert.deepEqual(store.products, afterPartial);
  assert.equal(store.alibabaSyncRuns?.[0]?.candidateHash, frozen.candidateHash);
  assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
  assert.equal(alerts.length, 0);
});

for (const target of ['p-2', 'p-1']) {
  test(`R1: quarantine keeps frozen expectations when relink to ${target} occurs after verification`, async (context) => {
    const frozen = await quarantineLinkedProducts();
    const sourceKey = alibabaSourceKey('primary', 'item-1');
    if (target === 'p-2') store.products?.push({ _id: target, name: 'Other' });
    const adapter = new RunnerMemoryAdapter(store);
    setAdapter(adapter);
    const get = adapter.get.bind(adapter);
    let relinked = false;
    context.mock.method(adapter, 'get', async (collection: string, id: string) => {
      if (collection === 'catalogSourceObservations' && !relinked) {
        relinked = true;
        assert.equal((await unlinkProduct('p-1', { now: T0 })).ok, true);
        assert.equal((await linkExistingProduct(sourceKey, target, { now: T0 })).ok, true);
      }
      return structuredClone(await get(collection, id));
    });
    assert.deepEqual(
      await approveQuarantinedRun({
        ...frozen,
        approvedByUserId: 'admin-1',
        now,
        alert: async (message) => {
          alerts.push(message);
        },
      }),
      { ok: false, reason: 'superseded' },
    );
    assert.equal(
      relinked,
      true,
      'the race ran after hash verification and before the promotion write',
    );
    assert.equal(
      store.products?.find((product) => product._id === target)?.alibabaCatalogPricing ?? null,
      null,
    );
    assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
    assert.equal(alerts.length, 0);
  });
}

function frozenSingleProductHash(runId: string, sourceKey: string): string {
  return computeCandidateHash({
    schemaVersion: 'alibaba-quarantine-identity-v2',
    runId,
    candidates: [
      {
        sourceKey,
        expectation: {
          productId: 'p-1',
          expectedRevision: 0,
          expectedPrimarySourceKey: sourceKey,
          expectedLinks: [productLink('item-1')],
        },
      },
    ],
    tombstones: [],
  });
}

test('quarantine approval rejects a mirror changed immediately before lease acquisition', async () => {
  setup();
  const runId = 'quarantined-race';
  const sourceKey = alibabaSourceKey('primary', 'item-1');
  const candidateHash = frozenSingleProductHash(runId, sourceKey);
  store.alibabaSyncRuns = [
    { _id: runId, status: 'quarantined', mode: 'incremental', candidateHash },
  ];
  store.alibabaSourceProducts = [
    {
      _id: sourceKey,
      sourceKey,
      connectionId: 'primary',
      sourceProductId: 'item-1',
      active: true,
      lastSeenRunId: runId,
    },
  ];
  store.alibabaProductLinks = [productLink('item-1')];
  store.products = [{ _id: 'p-1', unitPrice: 12.5, alibabaPrimarySourceKey: sourceKey }];
  class InterveningSyncAdapter extends RunnerMemoryAdapter {
    override async acquireAlibabaSyncLease(
      connectionId: string,
      holder: string,
      acquiredAt: string,
      ttlMs: number,
    ): Promise<AlibabaLeaseGrant> {
      await this.update('alibabaSourceProducts', sourceKey, { lastSeenRunId: 'newer-run' });
      return super.acquireAlibabaSyncLease(connectionId, holder, acquiredAt, ttlMs);
    }
  }
  setAdapter(new InterveningSyncAdapter(store));
  const result = await approveQuarantinedRun({
    runId,
    candidateHash,
    approvedByUserId: 'admin-1',
    now,
    alert: async (message) => {
      alerts.push(message);
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'superseded' });
  assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
  assert.equal(store.products?.[0]?.alibabaCatalogPricing, undefined);
  assert.equal(alerts.length, 0);
});

for (const takeoverCollection of ['products', 'alibabaSyncRuns']) {
  test(`quarantine approval cannot report success after takeover at ${takeoverCollection}`, async () => {
    setup();
    const runId = 'quarantined-takeover';
    const sourceKey = alibabaSourceKey('primary', 'item-1');
    const candidateHash = frozenSingleProductHash(runId, sourceKey);
    store.alibabaSyncRuns = [
      { _id: runId, status: 'quarantined', mode: 'incremental', candidateHash },
    ];
    store.alibabaSourceProducts = [
      {
        _id: sourceKey,
        sourceKey,
        connectionId: 'primary',
        sourceProductId: 'item-1',
        active: true,
        lastSeenRunId: runId,
      },
    ];
    store.alibabaProductLinks = [productLink('item-1')];
    store.products = [{ _id: 'p-1', unitPrice: 12.5, alibabaPrimarySourceKey: sourceKey }];
    let takeoverCount = 0;
    class TakeoverAdapter extends RunnerMemoryAdapter {
      override async mutateAlibabaProduct(
        input: AlibabaProductMutationInput,
      ): Promise<AlibabaProductMutationResult> {
        if (takeoverCollection === 'products' && input.action === 'promote') {
          takeoverCount += 1;
          await this.update('alibabaSyncLeases', input.guard.connectionId, {
            holder: 'new-owner',
            fence: input.guard.fence + 1,
          });
          const beforeMutation = structuredClone(this.store);
          const result = await super.mutateAlibabaProduct(input);
          assert.deepEqual(result, { ok: false, reason: 'fence-rejected' });
          assert.deepEqual(this.store, beforeMutation, 'a rejected transaction writes nothing');
          return result;
        }
        return super.mutateAlibabaProduct(input);
      }
      override async updateDocWithAlibabaLease(
        collection: string,
        id: string,
        patch: Record<string, unknown>,
        guard: AlibabaLeaseGuard,
      ): Promise<boolean> {
        if (collection === takeoverCollection) {
          takeoverCount += 1;
          await this.update('alibabaSyncLeases', guard.connectionId, {
            holder: 'new-owner',
            fence: guard.fence + 1,
          });
        }
        return super.updateDocWithAlibabaLease(collection, id, patch, guard);
      }
    }
    setAdapter(new TakeoverAdapter(store));
    const result = await approveQuarantinedRun({
      runId,
      candidateHash,
      approvedByUserId: 'admin-1',
      now,
      alert: async (message) => {
        alerts.push(message);
      },
    });
    assert.equal(takeoverCount, 1, 'the intended write reaches the takeover interception');
    assert.deepEqual(result, { ok: false, reason: 'lease-busy' });
    assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
    assert.equal(store.alibabaSyncLeases?.[0]?.holder, 'new-owner');
    assert.equal(alerts.length, 0);
  });
}

test('full run: an unverified ProductNotFound response quarantines without tombstoning', async () => {
  setup();
  const sourceKey = alibabaSourceKey('primary', 'item-gone');
  store.alibabaSyncCheckpoints = [
    {
      _id: 'primary',
      connectionId: 'primary',
      activeRunId: '',
      stage: 'enumerate',
      nextFullDueAt: '2026-08-06T12:00:00.000Z', // full due NOW
      nextIncrementalDueAt: '2026-08-06T16:15:00.000Z',
      committedCursor: '',
      continuationCount: 0,
    } as CollectionDoc,
  ];
  // Mirror knows item-gone from an older run; the live catalog only has item-1.
  store.alibabaSourceProducts = [
    {
      _id: sourceKey,
      sourceKey,
      connectionId: 'primary',
      sourceProductId: 'item-gone',
      active: true,
      lastSeenRunId: 'old-run',
    } as CollectionDoc,
  ];
  store.alibabaProductLinks = [productLink('item-gone')];
  const observationId = sourceObservationDocumentId('alibaba', sourceKey);
  store.catalogSourceObservations = [
    {
      _id: observationId,
      provider: 'alibaba',
      sourceProductKey: sourceKey,
      active: true,
      lastSeenOperationId: 'old-run',
    } as CollectionDoc,
  ];
  store.products = [
    {
      _id: 'p-1',
      name: 'Curated',
      category: 'bluetooth',
      unitPrice: 12.5,
      alibabaPrimarySourceKey: sourceKey,
    } as CollectionDoc,
  ];
  const backend = fakeBackend(() => [
    { id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' },
    { id: 'item-gone', modifiedMs: ITEM_TIME, priceLexeme: '9.99', removed: true },
  ]);

  const report = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'timer' });
  assert.equal(report.outcome, 'quarantined', JSON.stringify(report));

  const gone = store.alibabaSourceProducts?.find((doc) => doc._id === sourceKey);
  assert.equal(gone?.active, true, 'unverified provider codes must not tombstone');
  assert.equal(gone?.tombstonedAt, undefined);
  assert.ok(
    backend.calls.filter((call) => call === '/sync:alibaba.icbu.product.get').length >= 2,
    'confirmation fetch happened',
  );
  const product = store.products?.[0] as CollectionDoc;
  assert.equal(product.alibabaSourceStatus, undefined, 'linked product is not demoted');
  assert.equal(product.unitPrice, 12.5, 'legacy pricing untouched');
  assert.equal(store.catalogSourceObservations?.[0]?.active, true, 'common view remains active');
  assert.equal(store.catalogSourceObservations?.[0]?.lastSeenOperationId, 'old-run');
});

test('full run: auth, throttling, and unknown confirmation errors quarantine instead of tombstoning', async () => {
  for (const errorCode of [
    'ProductNotFound',
    'IllegalAccessToken',
    'AppCallLimit',
    'UnexpectedProviderFailure',
  ]) {
    setup();
    const sourceKey = alibabaSourceKey('primary', 'item-gone');
    store.alibabaSyncCheckpoints = [
      {
        _id: 'primary',
        connectionId: 'primary',
        activeRunId: '',
        stage: 'enumerate',
        nextFullDueAt: '2026-08-06T12:00:00.000Z',
        nextIncrementalDueAt: '2026-08-06T16:15:00.000Z',
        committedCursor: '',
        continuationCount: 0,
      } as CollectionDoc,
    ];
    store.alibabaSourceProducts = [
      {
        _id: sourceKey,
        sourceKey,
        connectionId: 'primary',
        sourceProductId: 'item-gone',
        active: true,
        lastSeenRunId: 'old-run',
      } as CollectionDoc,
    ];
    const backend = fakeBackend(() => [
      { id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' },
      { id: 'item-gone', modifiedMs: ITEM_TIME, priceLexeme: '9.99', removed: true },
    ]);
    const fetchWithConfirmationError = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      if (
        params.get('method') === 'alibaba.icbu.product.get' &&
        params.get('product_id') === 'item-gone'
      ) {
        return new Response(JSON.stringify({ error_code: errorCode }), { status: 200 });
      }
      return backend.fetchImpl(input, init);
    }) as typeof fetch;

    const report = await runSyncTick({
      deps: makeDeps(fetchWithConfirmationError),
      trigger: 'timer',
    });
    assert.equal(report.outcome, 'quarantined', errorCode);
    const source = store.alibabaSourceProducts?.find((doc) => doc._id === sourceKey);
    assert.equal(source?.active, true, `${errorCode} must not tombstone`);
    assert.equal(source?.tombstonedAt, undefined, `${errorCode} must not stamp absence`);
    assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
  }
});

test('full run: an invalid tombstone candidate id quarantines before a detail call', async () => {
  setup();
  const sourceKey = alibabaSourceKey('primary', 'legacy-product');
  store.alibabaSyncCheckpoints = [
    {
      _id: 'primary',
      connectionId: 'primary',
      activeRunId: '',
      stage: 'enumerate',
      nextFullDueAt: '2026-08-06T12:00:00.000Z',
      nextIncrementalDueAt: '2026-08-06T16:15:00.000Z',
      committedCursor: '',
      continuationCount: 0,
    } as CollectionDoc,
  ];
  store.alibabaSourceProducts = [
    {
      _id: sourceKey,
      sourceKey,
      connectionId: 'primary',
      sourceProductId: '',
      active: true,
      lastSeenRunId: 'old-run',
    } as CollectionDoc,
  ];
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);

  const report = await runSyncTick({ deps: makeDeps(backend.fetchImpl), trigger: 'timer' });
  assert.equal(report.outcome, 'quarantined', JSON.stringify(report));
  assert.equal(report.detail, undefined);
  assert.equal(store.alibabaSourceProducts?.[0]?.active, true);
  assert.equal(store.alibabaSourceProducts?.[0]?.tombstonedAt, undefined);
  assert.equal(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
  assert.equal(
    backend.calls.filter((call) => call === '/sync:alibaba.icbu.product.get').length,
    1,
    'only the enumerated live item is fetched; the invalid candidate never reaches product.get',
  );
});

test('incremental run quarantines when product.get returns a different valid product id', async () => {
  setup();
  const backend = fakeBackend(() => [{ id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' }]);
  const mismatchedDetail = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await backend.fetchImpl(input, init);
    const params = new URLSearchParams(String(init?.body ?? ''));
    if (params.get('method') !== 'alibaba.icbu.product.get') return response;
    const text = await response.text();
    return new Response(text.replace('"product_id":"item-1"', '"product_id":"other-item"'), {
      status: 200,
    });
  }) as typeof fetch;

  const report = await runSyncTick({ deps: makeDeps(mismatchedDetail), trigger: 'timer' });
  assert.equal(report.outcome, 'quarantined', JSON.stringify(report));
  assert.equal(report.detail, 'detail-product-id-mismatch');
  assert.equal(store.alibabaSourceProducts?.length ?? 0, 0, 'wrong product never enters mirror');
  assert.equal(store.alibabaSupplierOffers?.length ?? 0, 0);
  assert.equal(store.catalogSourceObservations?.length ?? 0, 0);
  assert.ok((store.alibabaSourcePayloads?.length ?? 0) >= 2, 'list and mismatched detail stay raw');
});

test('tombstone confirmation cannot let a different valid product satisfy the missing candidate', async () => {
  setup();
  const sourceKey = alibabaSourceKey('primary', 'item-gone');
  store.alibabaSyncCheckpoints = [
    {
      _id: 'primary',
      connectionId: 'primary',
      activeRunId: '',
      stage: 'enumerate',
      nextFullDueAt: '2026-08-06T12:00:00.000Z',
      nextIncrementalDueAt: '2026-08-06T16:15:00.000Z',
      committedCursor: '',
      continuationCount: 0,
    } as CollectionDoc,
  ];
  store.alibabaSourceProducts = [
    {
      _id: sourceKey,
      sourceKey,
      connectionId: 'primary',
      sourceProductId: 'item-gone',
      active: true,
      lastSeenRunId: 'old-run',
    } as CollectionDoc,
  ];
  const backend = fakeBackend(() => [
    { id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' },
    { id: 'item-gone', modifiedMs: ITEM_TIME, priceLexeme: '9.99', removed: true },
  ]);
  const mismatchedConfirmation = (async (input: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    if (
      params.get('method') === 'alibaba.icbu.product.get' &&
      params.get('product_id') === 'item-gone'
    ) {
      return new Response(
        JSON.stringify({
          result: {
            product: {
              product_id: 'other-item',
              subject: 'Wrong item',
              fob_currency: 'USD',
              sku_infos: [{ sku_id: 'other-sku', price: '1.00' }],
            },
          },
        }),
        { status: 200 },
      );
    }
    return backend.fetchImpl(input, init);
  }) as typeof fetch;

  const report = await runSyncTick({
    deps: makeDeps(mismatchedConfirmation),
    trigger: 'timer',
  });
  assert.equal(report.outcome, 'quarantined', JSON.stringify(report));
  assert.equal(store.alibabaSourceProducts?.find((doc) => doc._id === sourceKey)?.active, true);
  assert.equal(
    store.alibabaSourceProducts?.some((doc) => doc.sourceProductId === 'other-item'),
    false,
    'mismatched confirmation cannot create a different mirror row',
  );
});

test('a worker that loses its lease during confirmation cannot quarantine the run', async () => {
  setup();
  const sourceKey = alibabaSourceKey('primary', 'item-gone');
  store.alibabaSyncCheckpoints = [
    {
      _id: 'primary',
      connectionId: 'primary',
      activeRunId: '',
      stage: 'enumerate',
      nextFullDueAt: '2026-08-06T12:00:00.000Z',
      nextIncrementalDueAt: '2026-08-06T16:15:00.000Z',
      committedCursor: '',
      continuationCount: 0,
    } as CollectionDoc,
  ];
  store.alibabaSourceProducts = [
    {
      _id: sourceKey,
      sourceKey,
      connectionId: 'primary',
      sourceProductId: 'item-gone',
      active: true,
      lastSeenRunId: 'old-run',
    } as CollectionDoc,
  ];
  const backend = fakeBackend(() => [
    { id: 'item-1', modifiedMs: ITEM_TIME, priceLexeme: '2.50' },
    { id: 'item-gone', modifiedMs: ITEM_TIME, priceLexeme: '9.99', removed: true },
  ]);
  const takeoverDuringConfirmation = (async (input: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    if (
      params.get('method') === 'alibaba.icbu.product.get' &&
      params.get('product_id') === 'item-gone'
    ) {
      const lease = store.alibabaSyncLeases?.[0];
      if (lease) {
        lease.holder = 'new-holder';
        lease.fence = Number(lease.fence) + 1;
      }
    }
    return backend.fetchImpl(input, init);
  }) as typeof fetch;

  const report = await runSyncTick({
    deps: makeDeps(takeoverDuringConfirmation),
    trigger: 'timer',
  });
  assert.equal(report.outcome, 'lease-lost');
  assert.notEqual(store.alibabaSyncRuns?.[0]?.status, 'quarantined');
  assert.equal(store.alibabaSourceProducts?.[0]?.active, true);
});
