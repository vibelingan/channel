import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { CollectionDoc, ListResult } from '@vibelingan-channel/shared';
import type {
  AdapterListQuery,
  AlibabaLeaseGrant,
  AlibabaLeaseGuard,
  DbAdapter,
} from './adapter.ts';
import {
  ALIBABA_SYNC_LEASE_COLLECTION,
  holdsAlibabaLease,
  readAlibabaLeaseState,
  transitionAlibabaLeaseAcquire,
  transitionAlibabaLeaseRelease,
  transitionAlibabaLeaseRenew,
} from './adapter.ts';
import {
  acquireAlibabaSyncLease,
  assertAlibabaSyncLease,
  createDocWithId,
  releaseAlibabaSyncLease,
  renewAlibabaSyncLease,
  setAdapter,
  updateDocWithAlibabaLease,
  upsertDocWithId,
} from './index.ts';

const T0 = '2026-08-06T08:00:00.000Z';
const T1 = '2026-08-06T08:01:00.000Z';
const AFTER_TTL = '2026-08-06T08:03:00.001Z'; // T0 + 180s + 1ms
const TTL = 180_000;

const leaseDoc = (overrides: Record<string, unknown> = {}): CollectionDoc => ({
  _id: 'conn-1',
  holder: 'holder-a',
  fence: 3,
  acquiredAt: T0,
  heartbeatAt: T0,
  expiresAt: '2026-08-06T08:03:00.000Z',
  releasedAt: '',
  ...overrides,
});

// --- pure transitions --------------------------------------------------------

test('acquire on an absent lease grants fence 1', () => {
  const transition = transitionAlibabaLeaseAcquire(null, 'holder-a', T0, TTL);
  assert.equal(transition.result, 'granted');
  if (transition.result === 'granted') {
    assert.equal(transition.fence, 1);
    assert.equal(transition.doc.expiresAt, '2026-08-06T08:03:00.000Z');
    assert.equal(transition.doc.releasedAt, '');
  }
});

test('acquire against a live lease is busy', () => {
  assert.equal(transitionAlibabaLeaseAcquire(leaseDoc(), 'holder-b', T1, TTL).result, 'busy');
});

test('acquire after expiry or release increments the fence', () => {
  const afterExpiry = transitionAlibabaLeaseAcquire(leaseDoc(), 'holder-b', AFTER_TTL, TTL);
  assert.equal(afterExpiry.result, 'granted');
  if (afterExpiry.result === 'granted') assert.equal(afterExpiry.fence, 4);

  const afterRelease = transitionAlibabaLeaseAcquire(
    leaseDoc({ releasedAt: T1 }),
    'holder-b',
    T1,
    TTL,
  );
  assert.equal(afterRelease.result, 'granted');
  if (afterRelease.result === 'granted') assert.equal(afterRelease.fence, 4);
});

test('acquire at the exact expiry instant succeeds (expiresAt > now fails)', () => {
  const atExpiry = transitionAlibabaLeaseAcquire(
    leaseDoc(),
    'holder-b',
    '2026-08-06T08:03:00.000Z',
    TTL,
  );
  assert.equal(atExpiry.result, 'granted');
});

test('corrupt lease shapes are surfaced, never treated as free', () => {
  assert.equal(
    transitionAlibabaLeaseAcquire(leaseDoc({ fence: 'three' }), 'h', T0, TTL).result,
    'corrupt',
  );
  assert.equal(
    transitionAlibabaLeaseAcquire(leaseDoc({ expiresAt: 'tomorrow' }), 'h', T0, TTL).result,
    'corrupt',
  );
  assert.equal(readAlibabaLeaseState(leaseDoc({ holder: '' })).state, 'corrupt');
});

test('renew requires exact holder+fence on a live lease', () => {
  assert.equal(transitionAlibabaLeaseRenew(leaseDoc(), 'holder-a', 3, T1, TTL).result, 'applied');
  assert.equal(transitionAlibabaLeaseRenew(leaseDoc(), 'holder-a', 2, T1, TTL).result, 'rejected');
  assert.equal(transitionAlibabaLeaseRenew(leaseDoc(), 'holder-b', 3, T1, TTL).result, 'rejected');
  assert.equal(
    transitionAlibabaLeaseRenew(leaseDoc(), 'holder-a', 3, AFTER_TTL, TTL).result,
    'rejected',
    'an expired lease cannot be renewed — it must be re-acquired',
  );
  assert.equal(
    transitionAlibabaLeaseRenew(leaseDoc({ releasedAt: T0 }), 'holder-a', 3, T1, TTL).result,
    'rejected',
  );
});

test('release matches holder+fence, is idempotent, and survives expiry', () => {
  const released = transitionAlibabaLeaseRelease(leaseDoc(), 'holder-a', 3, T1);
  assert.equal(released.result, 'applied');
  if (released.result === 'applied') assert.equal(released.patch.releasedAt, T1);
  // Idempotent re-release: applied with an empty patch (instant preserved).
  const again = transitionAlibabaLeaseRelease(
    leaseDoc({ releasedAt: T1 }),
    'holder-a',
    3,
    AFTER_TTL,
  );
  assert.equal(again.result, 'applied');
  if (again.result === 'applied') assert.deepEqual(again.patch, {});
  // Overrun holder may still clean up after expiry (not yet fenced over).
  assert.equal(
    transitionAlibabaLeaseRelease(leaseDoc(), 'holder-a', 3, AFTER_TTL).result,
    'applied',
  );
  assert.equal(transitionAlibabaLeaseRelease(leaseDoc(), 'holder-b', 3, T1).result, 'rejected');
  assert.equal(transitionAlibabaLeaseRelease(leaseDoc(), 'holder-a', 2, T1).result, 'rejected');
  assert.equal(transitionAlibabaLeaseRelease(null, 'holder-a', 3, T1).result, 'rejected');
});

test('holdsAlibabaLease is the guard predicate matrix', () => {
  assert.equal(holdsAlibabaLease(leaseDoc(), 'holder-a', 3, T1), true);
  assert.equal(holdsAlibabaLease(leaseDoc(), 'holder-a', 2, T1), false);
  assert.equal(holdsAlibabaLease(leaseDoc(), 'holder-b', 3, T1), false);
  assert.equal(holdsAlibabaLease(leaseDoc(), 'holder-a', 3, AFTER_TTL), false);
  assert.equal(holdsAlibabaLease(leaseDoc({ releasedAt: T1 }), 'holder-a', 3, T1), false);
  assert.equal(holdsAlibabaLease(null, 'holder-a', 3, T1), false);
});

// --- facade + adapter behavior (memory adapter mirroring the JSON adapter) --

class LeaseMemoryAdapter implements DbAdapter {
  store: Record<string, CollectionDoc[]> = {};

  private docs(collection: string): CollectionDoc[] {
    this.store[collection] ??= [];
    return this.store[collection] as CollectionDoc[];
  }

  async list(_query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    throw new Error('not used');
  }
  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.docs(collection).find((d) => d._id === id) ?? null;
  }
  async findByField(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    const doc = { _id: `auto-${this.docs(collection).length}`, ...data } as CollectionDoc;
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
  async remove(): Promise<boolean> {
    throw new Error('not used');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }

  // The atomic sections below have SYNCHRONOUS bodies: like the JSON
  // adapter's withMutationLock critical sections, no await point can
  // interleave another caller mid-transition.
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
    const docs = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
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
    const docs = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
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
    const docs = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
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
    const lease =
      this.docs(ALIBABA_SYNC_LEASE_COLLECTION).find((d) => d._id === guard.connectionId) ?? null;
    if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return false;
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return false;
    docs[index] = { ...(docs[index] as CollectionDoc), ...patch };
    return true;
  }
}

function freshAdapter(): LeaseMemoryAdapter {
  const adapter = new LeaseMemoryAdapter();
  setAdapter(adapter);
  return adapter;
}

test('RACE: concurrent acquires admit exactly one holder', async () => {
  freshAdapter();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => acquireAlibabaSyncLease('conn-1', `holder-${i}`, T0, TTL)),
  );
  const granted = results.filter((r) => r.result === 'granted');
  assert.equal(granted.length, 1, 'exactly one winner');
  assert.equal(results.filter((r) => r.result === 'busy').length, 9);
});

test('fence takeover: stale holder cannot write after a new acquisition', async () => {
  const adapter = freshAdapter();
  adapter.store.products = [{ _id: 'p-1', name: 'Widget' } as CollectionDoc];

  const first = await acquireAlibabaSyncLease('conn-1', 'holder-a', T0, TTL);
  assert.equal(first.result, 'granted');
  const fenceA = first.result === 'granted' ? first.fence : 0;

  // holder-a's lease expires; holder-b takes over with a higher fence.
  const second = await acquireAlibabaSyncLease('conn-1', 'holder-b', AFTER_TTL, TTL);
  assert.equal(second.result, 'granted');
  const fenceB = second.result === 'granted' ? second.fence : 0;
  assert.equal(fenceB, fenceA + 1);

  // Stale holder-a write is rejected and the doc is untouched...
  const staleWrite = await updateDocWithAlibabaLease(
    'products',
    'p-1',
    { alibabaSourceStatus: 'available' },
    { connectionId: 'conn-1', holder: 'holder-a', fence: fenceA, now: AFTER_TTL },
  );
  assert.equal(staleWrite, false);
  assert.equal(adapter.store.products[0]?.alibabaSourceStatus, undefined);

  // ...while the live holder's fenced write lands.
  const liveWrite = await updateDocWithAlibabaLease(
    'products',
    'p-1',
    { alibabaSourceStatus: 'available' },
    { connectionId: 'conn-1', holder: 'holder-b', fence: fenceB, now: AFTER_TTL },
  );
  assert.equal(liveWrite, true);
  assert.equal(adapter.store.products[0]?.alibabaSourceStatus, 'available');
});

test('renew keeps a lease alive; assert reflects reality; release frees it', async () => {
  freshAdapter();
  const grant = await acquireAlibabaSyncLease('conn-1', 'holder-a', T0, TTL);
  assert.equal(grant.result, 'granted');
  assert.equal(await renewAlibabaSyncLease('conn-1', 'holder-a', 1, T1, TTL), true);
  assert.equal(await assertAlibabaSyncLease('conn-1', 'holder-a', 1, T1), true);
  assert.equal(await assertAlibabaSyncLease('conn-1', 'holder-b', 1, T1), false);
  assert.equal(await releaseAlibabaSyncLease('conn-1', 'holder-a', 1, T1), true);
  assert.equal(await assertAlibabaSyncLease('conn-1', 'holder-a', 1, T1), false);
  // Released lease is immediately re-acquirable with a bumped fence.
  const next = await acquireAlibabaSyncLease('conn-1', 'holder-b', T1, TTL);
  assert.equal(next.result, 'granted');
  if (next.result === 'granted') assert.equal(next.fence, 2);
});

test('RACE: createDocWithId admits exactly one winner per id', async () => {
  freshAdapter();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      createDocWithId('alibabaProductLinks', 'source-key-1', { productId: 'p-1' }),
    ),
  );
  assert.equal(results.filter((r) => r === 'created').length, 1);
  assert.equal(results.filter((r) => r === 'exists').length, 7);
});

test('createDocWithId stamps timestamps unless supplied; rejects unknown collections', async () => {
  const adapter = freshAdapter();
  await createDocWithId('alibabaProductLinks', 'k1', { productId: 'p-1' });
  const doc = adapter.store.alibabaProductLinks?.[0];
  assert.ok(doc?.createdAt, 'createdAt stamped');
  await createDocWithId('alibabaProductLinks', 'k2', { createdAt: T0, updatedAt: T0 });
  assert.equal(adapter.store.alibabaProductLinks?.[1]?.createdAt, T0, 'explicit instant wins');
  await assert.rejects(async () => createDocWithId('nonsense', 'k', {}));
});

test('upsertDocWithId creates then patches by deterministic id', async () => {
  const adapter = freshAdapter();
  const created = await upsertDocWithId('alibabaSupplierOffers', 'offer-1', {
    active: true,
    sourceSkuId: 's-1',
  });
  assert.equal(created._id, 'offer-1');
  const patched = await upsertDocWithId('alibabaSupplierOffers', 'offer-1', { active: false });
  assert.equal(patched.active, false);
  assert.equal(patched.sourceSkuId, 's-1', 'patch merges, not replaces');
  assert.equal(adapter.store.alibabaSupplierOffers?.length, 1);
});

test('facades reject malformed inputs before touching the adapter', async () => {
  freshAdapter();
  await assert.rejects(async () => acquireAlibabaSyncLease('', 'h', T0, TTL));
  await assert.rejects(async () => acquireAlibabaSyncLease('c', 'h', 'not-a-time', TTL));
  await assert.rejects(async () => acquireAlibabaSyncLease('c', 'h', T0, -1));
  await assert.rejects(async () => renewAlibabaSyncLease('c', 'h', 0, T0, TTL));
  await assert.rejects(async () =>
    updateDocWithAlibabaLease(
      'products',
      'p',
      {},
      {
        connectionId: 'c',
        holder: 'h',
        fence: 1,
        now: '2026-08-06 08:00',
      },
    ),
  );
});
