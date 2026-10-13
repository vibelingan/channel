import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type NodeSdkDatabase,
  claimAlibabaSyncRunInCloudBase,
  updateDocWithAlibabaLeaseInCloudBase,
  upsertDocWithAlibabaLeaseInCloudBase,
} from './cloudbase-adapter.ts';

const now = '2026-10-14T00:00:00.000Z';
const guard = { connectionId: 'primary', holder: 'old', fence: 1, now };
type Transaction = Parameters<Parameters<NodeSdkDatabase['runTransaction']>[0]>[0];

/** Mirrors the observed vendor snapshot isolation: only written rows conflict. */
function fixture(target: string, takeOver: boolean) {
  const targetId = target.split('/')[1];
  assert.ok(targetId);
  const rows = new Map<string, CollectionDoc>([
    [
      'alibabaSyncLeases/primary',
      {
        _id: 'primary',
        holder: 'old',
        fence: 1,
        expiresAt: '2026-10-14T00:03:00.000Z',
        releasedAt: '',
      },
    ],
    [target, { _id: targetId, value: 'baseline', sourceTitle: 'baseline' }],
    ['alibabaSyncCheckpoints/primary', { _id: 'primary', activeRunId: '', value: 'baseline' }],
  ]);
  const versions = new Map([...rows.keys()].map((key) => [key, 1]));
  let attempts = 0;
  let held = false;
  let release = () => {};
  let reached = () => {};
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  const db: NodeSdkDatabase = {
    command: { set: (value) => value },
    async runTransaction(operation) {
      for (let retry = 0; ; retry++) {
        attempts++;
        const snapshot = structuredClone(rows);
        const baseVersions = new Map(versions);
        const changed = new Set<string>();
        let writing = false;
        const tx: Transaction = {
          collection(name) {
            return {
              doc(id) {
                const key = `${name}/${id}`;
                return {
                  async get() {
                    assert.equal(writing, false, 'all reads precede writes');
                    if (takeOver && !held && key === target) {
                      held = true;
                      reached();
                      await gate;
                    }
                    return { data: structuredClone(snapshot.get(key) ?? null) };
                  },
                  async set(data) {
                    assert.equal(Object.hasOwn(data, '_id'), false);
                    writing = true;
                    changed.add(key);
                    const exists = snapshot.has(key);
                    snapshot.set(key, { ...structuredClone(data), _id: id });
                    return exists ? { updated: 1 } : { upserted: [{ _id: id }] };
                  },
                  async update(data) {
                    writing = true;
                    const before = snapshot.get(key);
                    if (!before) return { updated: 0 };
                    changed.add(key);
                    snapshot.set(key, { ...before, ...structuredClone(data) });
                    return { updated: 1 };
                  },
                  async remove() {
                    writing = true;
                    changed.add(key);
                    return { deleted: snapshot.delete(key) ? 1 : 0 };
                  },
                };
              },
            };
          },
        };
        const result = await operation(tx);
        if ([...changed].some((key) => versions.get(key) !== baseVersions.get(key))) {
          if (retry >= 3)
            throw Object.assign(new Error('snapshot write conflict'), {
              code: 'DATABASE_TRANSACTION_CONFLICT',
            });
          continue;
        }
        for (const key of changed) {
          const row = snapshot.get(key);
          if (row) rows.set(key, row);
          else rows.delete(key);
          versions.set(key, (versions.get(key) ?? 0) + 1);
          writes.push(key);
        }
        return result;
      }
    },
  };
  return {
    db,
    rows,
    writes,
    ready,
    release,
    attempts: () => attempts,
    takeover() {
      rows.set('alibabaSyncLeases/primary', {
        _id: 'primary',
        holder: 'new',
        fence: 2,
        expiresAt: '2026-10-14T00:04:00.000Z',
        releasedAt: '',
      });
      versions.set('alibabaSyncLeases/primary', 2);
    },
  };
}

for (const collection of [
  'alibabaSourceProducts',
  'catalogSourceObservations',
  'alibabaSupplierOffers',
  'products',
  'productVariants',
]) {
  for (const action of ['upsert', 'update'] as const) {
    test(`snapshot-only vendor: ${action} ${collection} cannot commit after lease takeover`, async () => {
      const h = fixture(`${collection}/item`, true);
      const operation =
        action === 'upsert'
          ? upsertDocWithAlibabaLeaseInCloudBase(
              h.db,
              collection,
              'item',
              { value: 'stale', sourceTitle: 'stale' },
              {},
              guard,
            )
          : updateDocWithAlibabaLeaseInCloudBase(
              h.db,
              collection,
              'item',
              { value: 'stale', sourceTitle: 'stale' },
              guard,
            );
      await h.ready;
      h.takeover();
      h.release();
      assert.equal(await operation, false);
      assert.equal(h.rows.get(`${collection}/item`)?.value, 'baseline');
      assert.equal(h.rows.get('alibabaSyncLeases/primary')?.holder, 'new');
      assert.deepEqual(h.writes, []);
      assert.ok(h.attempts() >= 2);
    });
    test(`snapshot-only vendor: current owner ${action} ${collection} still writes`, async () => {
      const h = fixture(`${collection}/item`, false);
      const result =
        action === 'upsert'
          ? await upsertDocWithAlibabaLeaseInCloudBase(
              h.db,
              collection,
              'item',
              { value: 'current' },
              {},
              guard,
            )
          : await updateDocWithAlibabaLeaseInCloudBase(
              h.db,
              collection,
              'item',
              { value: 'current' },
              guard,
            );
      assert.equal(result, true);
      assert.equal(h.rows.get(`${collection}/item`)?.value, 'current');
    });
  }
}

test('snapshot-only vendor: sync run and checkpoint cannot be claimed after lease takeover', async () => {
  const h = fixture('alibabaSyncCheckpoints/primary', true);
  const operation = claimAlibabaSyncRunInCloudBase(
    h.db,
    'run',
    { status: 'running' },
    { activeRunId: 'run' },
    guard,
  );
  await h.ready;
  h.takeover();
  h.release();
  assert.equal(await operation, 'lease-lost');
  assert.equal(h.rows.has('alibabaSyncRuns/run'), false);
  assert.equal(h.rows.get('alibabaSyncCheckpoints/primary')?.activeRunId, '');
  assert.deepEqual(h.writes, []);
});
