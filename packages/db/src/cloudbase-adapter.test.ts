import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  claimAlibabaSyncRunInCloudBase,
  upsertCatalogSourceObservationInCloudBase,
  upsertDocWithAlibabaLeaseInCloudBase,
} from './cloudbase-adapter.ts';

function fakeDatabase(initial: Record<string, CollectionDoc[]>) {
  const store = new Map(
    Object.entries(initial).map(([collection, docs]) => [
      collection,
      new Map(docs.map((doc) => [doc._id, { ...doc }])),
    ]),
  );
  const collection = (name: string) => ({
    doc: (id: string) => ({
      get: async () => ({ data: store.get(name)?.get(id) ?? null }),
      update: async (patch: Record<string, unknown>) => {
        const docs = store.get(name) ?? new Map<string, CollectionDoc>();
        const existing = docs.get(id);
        if (existing) docs.set(id, { ...existing, ...patch });
        store.set(name, docs);
        return {};
      },
      set: async (data: Record<string, unknown>) => {
        const docs = store.get(name) ?? new Map<string, CollectionDoc>();
        docs.set(id, { _id: id, ...data });
        store.set(name, docs);
        return {};
      },
      remove: async () => ({}),
    }),
  });
  return {
    store,
    db: {
      command: { set: (value: unknown) => value },
      runTransaction: async <T>(
        operation: (transaction: { collection: typeof collection }) => Promise<T>,
      ) => operation({ collection }),
    },
  };
}

test('production fenced upsert rejects a holder after lease takeover', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'new-holder',
        fence: 4,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    catalogSourceObservations: [{ _id: 'obs-1', active: false }],
  });

  const applied = await upsertDocWithAlibabaLeaseInCloudBase(
    harness.db,
    'catalogSourceObservations',
    'obs-1',
    { active: true },
    { firstSeenOperationId: 'run-old' },
    { connectionId: 'primary', holder: 'old-holder', fence: 3, now: at },
  );
  assert.equal(applied, false);
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.active, false);
});

test('production fenced upsert applies for the current lease holder', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'current-holder',
        fence: 4,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    catalogSourceObservations: [],
  });

  const applied = await upsertDocWithAlibabaLeaseInCloudBase(
    harness.db,
    'catalogSourceObservations',
    'obs-1',
    { active: true },
    { firstSeenOperationId: 'run-current' },
    { connectionId: 'primary', holder: 'current-holder', fence: 4, now: at },
  );
  assert.equal(applied, true);
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'run-current',
  );
});

test('production atomic run claim rejects a stale holder without creating an orphan run', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'new-holder',
        fence: 9,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    alibabaSyncCheckpoints: [{ _id: 'primary', activeRunId: '' }],
    alibabaSyncRuns: [],
  });

  const result = await claimAlibabaSyncRunInCloudBase(
    harness.db,
    'run-old',
    { status: 'running' },
    { activeRunId: 'run-old' },
    { connectionId: 'primary', holder: 'old-holder', fence: 8, now: at },
  );
  assert.equal(result, 'lease-lost');
  assert.equal(harness.store.get('alibabaSyncRuns')?.size, 0);
  assert.equal(harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId, '');
});

test('production atomic run claim creates the run and claims its checkpoint together', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'current-holder',
        fence: 9,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    alibabaSyncCheckpoints: [{ _id: 'primary', activeRunId: '' }],
    alibabaSyncRuns: [],
  });

  const result = await claimAlibabaSyncRunInCloudBase(
    harness.db,
    'run-current',
    { _id: 'forged-run-id', status: 'running' },
    { _id: 'forged-checkpoint-id', activeRunId: 'run-current', stage: 'enumerate' },
    { connectionId: 'primary', holder: 'current-holder', fence: 9, now: at },
  );
  assert.equal(result, 'claimed');
  assert.deepEqual(harness.store.get('alibabaSyncRuns')?.get('run-current'), {
    _id: 'run-current',
    status: 'running',
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(
    harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId,
    'run-current',
  );
});

test('production source observation upsert rejects older captures and preserves first-seen provenance', async () => {
  const harness = fakeDatabase({
    catalogSourceObservations: [
      {
        _id: 'obs-1',
        observedAt: '2026-09-04T10:00:00.000Z',
        title: 'newer',
        firstSeenOperationId: 'first-import',
      },
    ],
  });

  const stale = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'obs-1',
    { observedAt: '2026-09-04T09:00:00.000Z', title: 'older' },
    { firstSeenOperationId: 'wrong-import' },
    '2026-09-04T10:01:00.000Z',
  );
  assert.equal(stale.result, 'stale');
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.title, 'newer');
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'first-import',
  );

  const applied = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'obs-1',
    { observedAt: '2026-09-04T11:00:00.000Z', title: 'newest' },
    { firstSeenOperationId: 'wrong-import' },
    '2026-09-04T11:01:00.000Z',
  );
  assert.equal(applied.result, 'applied');
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.title, 'newest');
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'first-import',
  );
});
