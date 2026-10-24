import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type NodeSdkDatabase,
  acquireImageMutationInCloudBase,
  manageImageDeletionInCloudBase,
  releaseImageMutationInCloudBase,
} from './cloudbase-adapter.ts';
import { executeImageDeletion } from './image-deletion-runner.ts';

const now = '2026-10-15T00:00:00.000Z';
const begin = {
  action: 'begin',
  imageId: 'i',
  uploadedByUserId: 'u',
  owner: 'op',
  startedAt: now,
} as const;
function fixture(array: boolean, free = false) {
  let row: CollectionDoc | null = {
    _id: 'i',
    status: 'active',
    uploadedByUserId: 'u',
    publishedRefCount: 0,
    imageMutationOwner: free ? '' : 'op',
    imageMutationStartedAt: free ? '' : now,
    storageProvider: 'cloudbase-storage',
    storageFileId: 'cloud://env.bucket/one',
  };
  const controls = { set: 'ok', remove: 'ok', lostCommit: false, maximumOperations: 0 };
  const db: Pick<NodeSdkDatabase, 'runTransaction'> = {
    async runTransaction(operation) {
      let copy = structuredClone(row);
      let operations = 0;
      let writing = false;
      const result = await operation({
        collection: (collection) => {
          assert.equal(collection, 'images');
          return {
            doc: (id) => {
              assert.equal(id, 'i');
              return {
                get: async () => {
                  operations++;
                  assert.equal(writing, false);
                  return { data: array ? (copy ? [copy] : []) : copy };
                },
                update: async (data) => {
                  operations++;
                  writing = true;
                  if (controls.set === 'throw') throw new Error('update unavailable');
                  if (controls.set === 'silent') return { updated: 0 };
                  if (controls.set === 'code') return { code: 'DATABASE_TRANSACTION_CONFLICT' };
                  assert.ok(copy);
                  copy = { ...copy, ...data };
                  return { updated: 1 };
                },
                set: async (data) => {
                  operations++;
                  writing = true;
                  assert.equal(Object.hasOwn(data, '_id'), false, 'SDK set payload excludes _id');
                  if (controls.set === 'throw') throw new Error('set unavailable');
                  if (controls.set === 'silent') return { updated: 0 };
                  if (controls.set === 'code') return { code: 'DATABASE_TRANSACTION_CONFLICT' };
                  if (controls.set === 'wrong-upsert') return { upserted: [{ _id: 'other' }] };
                  copy = { ...data, _id: id };
                  return { updated: 1 };
                },
                remove: async () => {
                  operations++;
                  writing = true;
                  if (controls.remove === 'throw') throw new Error('remove unavailable');
                  if (controls.remove === 'silent') return { deleted: 0 };
                  if (controls.remove === 'code') return { code: 'DATABASE_TRANSACTION_CONFLICT' };
                  copy = null;
                  return { deleted: 1 };
                },
              };
            },
          };
        },
      });
      controls.maximumOperations = Math.max(controls.maximumOperations, operations);
      row = copy;
      if (controls.lostCommit) {
        controls.lostCommit = false;
        throw new Error('commit response lost');
      }
      return result;
    },
  };
  return {
    db,
    controls,
    get row() {
      return row;
    },
  };
}

for (const array of [false, true]) {
  test(`cloud image teardown uses confirmed writes and bounded transactions (array=${array})`, async () => {
    const f = fixture(array);
    let deleted = 0;
    assert.equal(
      await executeImageDeletion(
        { manage: (c) => manageImageDeletionInCloudBase(f.db, c), get: async () => f.row },
        begin,
        async () => {
          assert.equal(f.row?.status, 'deleted');
          deleted++;
        },
      ),
      'deleted',
    );
    assert.equal(deleted, 1);
    assert.equal(f.row, null);
    assert.equal(f.controls.maximumOperations, 2);
  });
  for (const mode of ['throw', 'silent', 'code', 'wrong-upsert'])
    test(`cloud quarantine ${mode} cannot delete storage (array=${array})`, async () => {
      const f = fixture(array);
      f.controls.set = mode;
      let deleted = 0;
      assert.equal(
        await executeImageDeletion(
          { manage: (c) => manageImageDeletionInCloudBase(f.db, c), get: async () => f.row },
          begin,
          async () => {
            deleted++;
          },
        ),
        'failed',
      );
      assert.equal(deleted, 0);
      assert.equal(f.row?.status, 'active');
    });
  for (const mode of ['throw', 'silent', 'code'])
    test(`cloud finalization ${mode} keeps a durable retry (array=${array})`, async () => {
      const f = fixture(array);
      f.controls.remove = mode;
      const run = () =>
        executeImageDeletion(
          { manage: (c) => manageImageDeletionInCloudBase(f.db, c), get: async () => f.row },
          begin,
          async () => {},
        );
      assert.equal(await run(), 'failed');
      assert.equal(f.row?.status, 'deleted');
      f.controls.remove = 'ok';
      assert.equal(await run(), 'deleted');
      assert.equal(f.row, null);
    });
  for (const phase of ['begin', 'finish'])
    test(`cloud committed ${phase} ACK loss is resolved by read-back (array=${array})`, async () => {
      const f = fixture(array);
      if (phase === 'begin') f.controls.lostCommit = true;
      assert.equal(
        await executeImageDeletion(
          {
            manage: (c) => {
              if (c.action === 'finish' && phase === 'finish') f.controls.lostCommit = true;
              return manageImageDeletionInCloudBase(f.db, c);
            },
            get: async () => f.row,
          },
          begin,
          async () => {
            assert.equal(f.row?.status, 'deleted');
          },
        ),
        'deleted',
      );
      assert.equal(f.row, null);
    });
}

for (const action of ['acquire', 'release'] as const) {
  for (const mode of ['silent', 'code', 'throw'])
    test(`image lock ${action} requires a confirmed update (${mode})`, async () => {
      const f = fixture(true, action === 'acquire');
      f.controls.set = mode;
      const run =
        action === 'acquire'
          ? acquireImageMutationInCloudBase(f.db, 'i', 'op', now)
          : releaseImageMutationInCloudBase(f.db, 'i', 'op');
      await assert.rejects(run);
      assert.equal(f.row?.imageMutationOwner, action === 'acquire' ? '' : 'op');
    });
}

test('native cloud lock updates preserve ownership and release only the recorded holder', async () => {
  const f = fixture(true, true);
  assert.equal(await acquireImageMutationInCloudBase(f.db, 'i', 'op', now), 'acquired');
  assert.equal(await acquireImageMutationInCloudBase(f.db, 'i', 'other', now), 'busy');
  assert.equal(await releaseImageMutationInCloudBase(f.db, 'i', 'other'), 'not-owner');
  assert.equal(await releaseImageMutationInCloudBase(f.db, 'i', 'op'), 'released');
  assert.equal(f.row?.imageMutationOwner, '');
});
