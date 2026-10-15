import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type NodeSdkDatabase, manageImageUploadInCloudBase } from './cloudbase-adapter.ts';
import {
  type ImageUploadCommand,
  hasImageUploadCompletion,
  imageUploadInputDigest,
} from './image-upload.ts';
const now = '2026-10-15T02:00:00.000Z';
const image: CollectionDoc = {
  _id: 'upload',
  uploadedByUserId: 'u',
  uploadIntentId: 'intent',
  purpose: 'catalog-image',
  status: 'pending',
  storageProvider: 'local-disk',
  storageMode: 'local-disk',
  storageFileId: 'local-disk:Exact%20Key ',
  storagePath: 'upload/a.png',
  mimeType: 'image/png',
  byteSize: 68,
  publishedRefCount: 0,
  imageMutationOwner: 'op',
  imageMutationStartedAt: now,
};
const activate = {
  action: 'activate',
  imageId: 'upload',
  uploadedByUserId: 'u',
  owner: 'op',
  inputDigest: imageUploadInputDigest(image),
  byteSize: 68,
  checksumSha256: 'a'.repeat(64),
  now,
} as const;
const reject = {
  action: 'reject',
  imageId: 'upload',
  uploadedByUserId: 'u',
  owner: 'op',
  inputDigest: activate.inputDigest,
  reason: 'content',
  now,
} as const;
function fixture(array: boolean) {
  const rows = new Map<string, CollectionDoc>();
  const controls = {
    set: 'ok',
    remove: 'ok',
    loseCommit: false,
    wrongId: false,
    raceImageId: null as string | null,
    races: 0,
    maximumOperations: 0,
  };
  const key = (collection: string, id: string) => `${collection}\0${id}`;
  const db: Pick<NodeSdkDatabase, 'runTransaction'> = {
    async runTransaction(operation) {
      const before = structuredClone(rows);
      const copy = structuredClone(rows);
      const written = new Set<string>();
      let operations = 0;
      let writing = false;
      const result = await operation({
        collection: (collection) => ({
          doc: (id) => ({
            get: async () => {
              operations++;
              assert.equal(writing, false, 'native bridge reads precede writes');
              let row = copy.get(key(collection, id)) ?? null;
              if (row && controls.wrongId && collection === 'images')
                row = { ...row, _id: 'foreign' };
              return { data: array ? (row ? [row] : []) : row };
            },
            set: async (data) => {
              operations++;
              writing = true;
              written.add(key(collection, id));
              assert.equal(Object.hasOwn(data, '_id'), false, 'SDK set payload excludes _id');
              const exists = copy.has(key(collection, id));
              copy.set(key(collection, id), { ...data, _id: id });
              if (controls.set === 'throw') throw new Error('set outcome unknown');
              if (controls.set === 'silent') return { updated: 0 };
              if (controls.set === 'code') return { code: 'DATABASE_TRANSACTION_CONFLICT' };
              if (controls.set === 'wrong-upsert') return { upserted: [{ _id: 'foreign' }] };
              return exists ? { updated: 1 } : { updated: 0, upserted: [{ _id: id }] };
            },
            update: async (data) => {
              operations++;
              writing = true;
              written.add(key(collection, id));
              const row = copy.get(key(collection, id));
              assert.ok(row);
              copy.set(key(collection, id), { ...row, ...data });
              return { updated: 1 };
            },
            remove: async () => {
              operations++;
              writing = true;
              written.add(key(collection, id));
              copy.delete(key(collection, id));
              if (controls.remove === 'throw') throw new Error('remove outcome unknown');
              if (controls.remove === 'silent') return { deleted: 0 };
              if (controls.remove === 'code') return { code: 'DATABASE_TRANSACTION_CONFLICT' };
              return { deleted: 1 };
            },
          }),
        }),
      });
      controls.maximumOperations = Math.max(controls.maximumOperations, operations);
      if (controls.raceImageId) {
        const racingKey = key('images', controls.raceImageId);
        const racing = rows.get(racingKey);
        assert.ok(racing);
        rows.set(racingKey, { ...racing, status: 'deleted' });
        controls.raceImageId = null;
        controls.races++;
      }
      for (const id of written) {
        if (!isDeepStrictEqual(before.get(id), rows.get(id)))
          throw new Error('DATABASE_TRANSACTION_CONFLICT: written document changed');
      }
      for (const id of written) {
        const next = copy.get(id);
        if (next) rows.set(id, next);
        else rows.delete(id);
      }
      if (controls.loseCommit) {
        controls.loseCommit = false;
        throw new Error('commit ACK lost');
      }
      return result;
    },
  };
  return {
    db,
    controls,
    put: (collection: string, row: CollectionDoc) =>
      rows.set(key(collection, row._id), structuredClone(row)),
    snapshot: () => structuredClone(rows),
    get: (collection: string, id: string) => structuredClone(rows.get(key(collection, id)) ?? null),
    run: (command: ImageUploadCommand) => manageImageUploadInCloudBase(db, command),
  };
}

function seeded(array: boolean) {
  const f = fixture(array);
  f.put('users', { _id: 'u', role: 'admin', status: 'active' });
  f.put('images', image);
  return f;
}
for (const array of [false, true]) {
  test(`cloud upload activate and reject replay one committed receipt, object/array=${array}`, async () => {
    for (const command of [activate, reject]) {
      const f = seeded(array);
      f.controls.loseCommit = true;
      await assert.rejects(f.run(command), /commit ACK lost/);
      assert.equal(
        (await f.run(command)).status,
        command.action === 'activate' ? 'active' : 'rejected',
      );
      assert.equal(
        f.get('images', 'upload')?.status,
        command.action === 'activate' ? 'active' : 'failed',
      );
      assert.ok(f.controls.maximumOperations <= 3);
    }
  });
  for (const failure of ['throw', 'silent', 'code', 'wrong-upsert'])
    test(`cloud upload unconfirmed ${failure} rolls back, object/array=${array}`, async () => {
      const f = seeded(array);
      const before = f.snapshot();
      f.controls.set = failure;
      await assert.rejects(f.run(activate));
      assert.deepEqual(f.snapshot(), before);
    });
  test(`cloud upload cannot trust a foreign image identity, object/array=${array}`, async () => {
    const f = seeded(array);
    f.controls.wrongId = true;
    const before = f.snapshot();
    assert.equal((await f.run(activate)).status, 'corrupt');
    assert.deepEqual(f.snapshot(), before);
  });
  test(`cloud upload rejects changes to every bound input field, object/array=${array}`, async () => {
    for (const patch of [
      { uploadedByUserId: 'other' },
      { uploadIntentId: 'other' },
      { purpose: 'other' },
      { storageProvider: 'cloudbase-storage' },
      { storageMode: 'classic-nosql-storage' },
      { storagePath: 'other' },
      { storageFileId: 'other' },
      { mimeType: 'image/jpeg' },
      { byteSize: 69 },
      { checksumSha256: 'b'.repeat(64) },
      { status: 'deleted' },
      { publishedRefCount: 1 },
      { imageMutationOwner: 'other' },
      { sourceMediaImport: { schemaVersion: 'new' } },
    ]) {
      const f = seeded(array);
      f.put('images', { ...image, ...patch });
      assert.notEqual((await f.run(activate)).status, 'active');
      assert.equal(f.get('images', 'upload')?.status, patch.status ?? 'pending');
    }
  });
  test(`cloud upload revoked actor cannot finalize, object/array=${array}`, async () => {
    for (const patch of [{ role: 'viewer' }, { status: 'suspended' }]) {
      const f = seeded(array);
      f.put('users', { _id: 'u', role: 'admin', status: 'active', ...patch });
      assert.equal((await f.run(activate)).status, 'forbidden');
      assert.equal(f.get('images', 'upload')?.status, 'pending');
    }
  });
  test(`cloud upload completion strict version and content fingerprint prevent a false cached success, object/array=${array}`, async () => {
    const f = seeded(array);
    assert.equal((await f.run(activate)).status, 'active');
    const saved = f.get('images', 'upload');
    assert.ok(saved);
    assert.ok(hasImageUploadCompletion(saved));
    const completion = saved.imageUploadCompletion;
    assert.ok(completion && typeof completion === 'object' && !Array.isArray(completion));
    for (const patch of [
      { storageFileId: 'other' },
      { byteSize: 1 },
      { checksumSha256: 'b'.repeat(64) },
      { mimeType: 'image/jpeg' },
      { imageUploadCompletion: { schemaVersion: 'image-upload-completion-v2' } },
      { imageUploadCompletion: { ...completion, unexpected: true } },
    ]) {
      const changed: CollectionDoc = { ...saved, ...patch };
      assert.equal(hasImageUploadCompletion(changed), false);
      f.put('images', changed);
      assert.equal((await f.run(activate)).status, 'conflict');
    }
  });
}

for (const array of [false, true])
  test(`cloud legacy direct-upload confirmation preserves referenced content, object/array=${array}`, async () => {
    for (const refs of [0, 2]) {
      const f = seeded(array);
      const legacy = {
        ...image,
        status: 'active',
        publishedRefCount: refs,
        checksumSha256: activate.checksumSha256,
      };
      f.put('images', legacy);
      const command = { ...activate, inputDigest: imageUploadInputDigest(legacy) };
      assert.equal((await f.run({ ...command, byteSize: 69 })).status, 'conflict');
      assert.equal(
        (await f.run({ ...reject, inputDigest: command.inputDigest })).status,
        'conflict',
      );
      assert.equal((await f.run(command)).status, 'active');
      assert.equal((await f.run(command)).status, 'active');
      const saved = f.get('images', 'upload');
      assert.ok(saved && hasImageUploadCompletion(saved));
      assert.equal(saved.publishedRefCount, refs);
      assert.equal(saved.storageFileId, image.storageFileId);
    }
  });
