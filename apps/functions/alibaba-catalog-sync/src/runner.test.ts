import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type AlibabaClient,
  DEFAULT_ALIBABA_ENDPOINTS,
  alibabaSourceKey,
  createAlibabaClient,
  initialEnumerationState,
} from '@vibelingan-channel/alibaba-catalog-sync';
import type {
  AdapterListQuery,
  AlibabaLeaseGrant,
  AlibabaLeaseGuard,
  DbAdapter,
} from '@vibelingan-channel/db';
import {
  holdsAlibabaLease,
  setAdapter,
  transitionAlibabaLeaseAcquire,
  transitionAlibabaLeaseRelease,
  transitionAlibabaLeaseRenew,
} from '@vibelingan-channel/db';
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
import { approveQuarantinedRun } from './quarantine.ts';
import { runSyncTick } from './runner.ts';

// --- full-surface memory adapter --------------------------------------------

type Store = Record<string, CollectionDoc[]>;

class RunnerMemoryAdapter implements DbAdapter {
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
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const params = new URLSearchParams(String(init?.body ?? ''));
    calls.push(path);
    if (path.endsWith('/product/list')) {
      const from = Date.parse(params.get('gmt_modified_from') ?? '1970-01-01');
      const to = Date.parse(params.get('gmt_modified_to') ?? '2100-01-01');
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
    if (path.endsWith('/product/get')) {
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

test('incremental tick: enumerates the window, ingests, promotes linked, advances the cursor', async () => {
  setup();
  const sourceKey = alibabaSourceKey('primary', 'item-1');
  store.alibabaProductLinks = [{ _id: sourceKey, sourceKey, productId: 'p-1' } as CollectionDoc];
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
  store.alibabaProductLinks = [{ _id: sourceKey, sourceKey, productId: 'p-1' } as CollectionDoc];
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

test('full run: a vanished item is CONFIRMED before tombstoning and demotes its product', async () => {
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
  store.alibabaProductLinks = [{ _id: sourceKey, sourceKey, productId: 'p-1' } as CollectionDoc];
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
  assert.equal(report.outcome, 'completed', JSON.stringify(report));

  const gone = store.alibabaSourceProducts?.find((doc) => doc._id === sourceKey);
  assert.equal(gone?.active, false, 'tombstoned only after detail confirmation');
  assert.ok(typeof gone?.tombstonedAt === 'string' && gone.tombstonedAt !== '');
  assert.ok(
    backend.calls.filter((path) => path.endsWith('/product/get')).length >= 2,
    'confirmation fetch happened',
  );
  const product = store.products?.[0] as CollectionDoc;
  assert.equal(product.alibabaSourceStatus, 'removed', 'linked product demoted');
  assert.equal(product.unitPrice, 12.5, 'legacy pricing untouched');
});
