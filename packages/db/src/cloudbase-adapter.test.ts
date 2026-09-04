import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { upsertDocWithAlibabaLeaseInCloudBase } from './cloudbase-adapter.ts';

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
