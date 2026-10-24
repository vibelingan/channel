import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type NodeSdkDatabase,
  acquireImageMutationInCloudBase,
  manageSourceMediaImportInCloudBase,
} from './cloudbase-adapter.ts';
import type { SourceMediaImportCommand } from './source-media-import.ts';
const now = '2026-10-15T00:00:00.000Z';
const base = {
  sourceUrl: 'https://sc04.alicdn.com/cloud.png',
  operationId: 'op',
  imageId: 'image',
  now,
};
const claim = { ...base, action: 'claim' } as const;
const target = {
  storageProvider: 'cloudbase-storage',
  storageMode: 'classic-nosql-storage',
  storageFileId: 'cloud://env.bucket/Case%20Key ',
  storagePath: 'catalog/owned/a.png',
  byteSize: 68,
  checksumSha256: 'a'.repeat(64),
  mimeType: 'image/png',
  name: 'a.png',
} as const;
const checkpoint = { ...base, action: 'checkpoint', target } as const;
const activate = { ...base, action: 'activate', target } as const;
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
              if (row && controls.wrongId) row = { ...row, _id: 'foreign' };
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
    snapshot: () => structuredClone(rows),
    get: (collection: string, id: string) => structuredClone(rows.get(key(collection, id)) ?? null),
    run: (command: SourceMediaImportCommand) => manageSourceMediaImportInCloudBase(db, command),
  };
}
for (const array of [false, true]) {
  test(`cloud source importer uses native get/set and exact ACKs, object/array=${array}`, async () => {
    const f = fixture(array);
    assert.equal((await f.run(claim)).status, 'claimed');
    assert.equal((await f.run(checkpoint)).status, 'checkpointed');
    assert.equal((await f.run(activate)).status, 'ready');
    assert.equal(f.get('images', base.imageId)?.storageFileId, target.storageFileId);
    assert.equal(f.get('images', base.imageId)?.status, 'active');
    assert.ok(f.controls.maximumOperations <= 4);
  });
  for (const failure of ['throw', 'silent', 'code', 'wrong-upsert']) {
    test(`cloud unconfirmed source reservation ${failure} rolls back both rows, object/array=${array}`, async () => {
      const f = fixture(array);
      const before = f.snapshot();
      f.controls.set = failure;
      await assert.rejects(f.run(claim));
      assert.deepEqual(f.snapshot(), before);
      f.controls.set = 'ok';
      assert.equal((await f.run(claim)).status, 'claimed');
    });
  }
  for (const stage of ['claim', 'checkpoint', 'activate'] as const) {
    test(`cloud ${stage} committed ACK loss replays same operation, object/array=${array}`, async () => {
      const f = fixture(array);
      if (stage !== 'claim') await f.run(claim);
      if (stage === 'activate') await f.run(checkpoint);
      const command = stage === 'claim' ? claim : stage === 'checkpoint' ? checkpoint : activate;
      f.controls.loseCommit = true;
      await assert.rejects(f.run(command), /commit ACK lost/);
      assert.equal(
        (await f.run(command)).status,
        stage === 'claim' ? 'claimed' : stage === 'checkpoint' ? 'checkpointed' : 'ready',
      );
      assert.ok(f.get('images', base.imageId));
    });
  }
  for (const failure of ['throw', 'silent', 'code']) {
    test(`cloud failed pending-row removal ${failure} cannot partially bind checksum reuse, object/array=${array}`, async () => {
      const f = fixture(array);
      await f.run(claim);
      await f.run(checkpoint);
      await f.run(activate);
      const second = {
        sourceUrl: 'https://sc05.alicdn.com/reuse.png',
        operationId: 'second',
        imageId: 'pending',
        now,
      };
      await f.run({ ...second, action: 'claim' });
      assert.equal(
        await acquireImageMutationInCloudBase(f.db, base.imageId, second.operationId, now),
        'acquired',
      );
      const before = f.snapshot();
      f.controls.remove = failure;
      const command = {
        ...second,
        action: 'reuse',
        existingImageId: base.imageId,
        checksumSha256: target.checksumSha256,
      } as const;
      await assert.rejects(f.run(command));
      assert.deepEqual(f.snapshot(), before);
      f.controls.remove = 'ok';
      f.controls.loseCommit = true;
      await assert.rejects(f.run(command), /commit ACK lost/);
      assert.deepEqual(await f.run(command), {
        status: 'ready',
        imageId: base.imageId,
        deduplicated: true,
      });
      assert.equal(f.get('images', 'pending'), null);
      assert.ok(f.controls.maximumOperations <= 6);
    });
  }
  test(`cloud foreign document identity cannot retire or mutate source state, object/array=${array}`, async () => {
    const f = fixture(array);
    await f.run(claim);
    await f.run(checkpoint);
    const before = f.snapshot();
    f.controls.wrongId = true;
    assert.equal(
      (
        await f.run({
          action: 'retire',
          imageId: base.imageId,
          owner: 'cleanup',
          now: '2026-10-15T00:03:00.000Z',
        })
      ).status,
      'corrupt',
    );
    assert.equal((await f.run(activate)).status, 'corrupt');
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const array of [false, true]) {
  test(`cloud foreign terminal source row cannot resume retirement, object/array=${array}`, async () => {
    const f = fixture(array);
    await f.run(claim);
    await f.run(checkpoint);
    assert.equal(
      await acquireImageMutationInCloudBase(f.db, base.imageId, 'cleanup', now),
      'acquired',
    );
    const command = {
      action: 'retire',
      imageId: base.imageId,
      owner: 'cleanup',
      now: '2026-10-15T00:03:00.000Z',
    } as const;
    assert.equal((await f.run(command)).status, 'retired');
    const before = f.snapshot();
    f.controls.wrongId = true;
    assert.equal((await f.run(command)).status, 'corrupt');
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const array of [false, true]) {
  test(`cloud checksum reuse physically fences a concurrent image retirement, object/array=${array}`, async () => {
    const f = fixture(array);
    await f.run(claim);
    await f.run(checkpoint);
    await f.run(activate);
    const second = {
      sourceUrl: 'https://sc05.alicdn.com/racing.png',
      operationId: 'second',
      imageId: 'pending',
      now,
    };
    await f.run({ ...second, action: 'claim' });
    assert.equal(
      await acquireImageMutationInCloudBase(f.db, base.imageId, second.operationId, now),
      'acquired',
    );
    f.controls.raceImageId = base.imageId;
    const command = {
      ...second,
      action: 'reuse',
      existingImageId: base.imageId,
      checksumSha256: target.checksumSha256,
    } as const;
    await assert.rejects(f.run(command), /DATABASE_TRANSACTION_CONFLICT/);
    assert.equal(f.controls.races, 1);
    assert.equal(f.get('images', base.imageId)?.status, 'deleted');
    assert.equal(f.get('images', second.imageId)?.status, 'pending');
    assert.equal((await f.run(command)).status, 'conflict');
    const link = [...f.snapshot().values()].find((row) => row.sourceUrl === second.sourceUrl);
    assert.ok(link);
    assert.equal(link.imageId, undefined);
  });
}
