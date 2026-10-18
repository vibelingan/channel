import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import {
  type AdapterListQuery,
  type SourceMediaImportCommand,
  setAdapter,
} from '@vibelingan-channel/db';
import {
  type PutMediaObjectInput,
  type PutMediaObjectOptions,
  setMediaStorage,
} from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from '../../../packages/db/src/catalog-image-references.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { importCandidateImage } from '../../functions/alibaba-catalog-sync/src/media-import.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const pixels = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=',
  'base64',
);
const sourceUrl = 'https://sc04.alicdn.com/a.png';
const deps = {
  fetchImpl: async () => new Response(new Uint8Array(pixels)),
  resolveDns: async () => ['104.16.1.1'],
};
async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'channel-source-media-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controls: {
    phase: SourceMediaImportCommand['action'] | null;
    faults: number;
    blockAfterCommit: boolean;
    loseUploadAck: boolean;
    deleteFailure: 'before' | 'after' | null;
    deleteFailureFileId: string | null;
    releaseFailure: 'before' | 'after' | null;
    releaseFaults: number;
    afterSelection: (() => Promise<void>) | null;
  } = {
    phase: null,
    faults: 0,
    blockAfterCommit: false,
    loseUploadAck: false,
    deleteFailure: null,
    deleteFailureFileId: null,
    releaseFailure: null,
    releaseFaults: 0,
    afterSelection: null,
  };
  class Adapter extends JsonFileAdapter {
    override async releaseImageMutation(imageId: string, owner: string) {
      const failure = controls.releaseFailure;
      controls.releaseFailure = null;
      if (failure === 'before') {
        controls.releaseFaults++;
        throw new Error('mutex release not committed');
      }
      const result = await super.releaseImageMutation(imageId, owner);
      if (failure === 'after') {
        controls.releaseFaults++;
        throw new Error('mutex release committed, ACK lost');
      }
      return result;
    }

    override async list(query: AdapterListQuery) {
      const result = await super.list(query);
      if (
        controls.afterSelection &&
        query.collection === 'images' &&
        query.filter?.clauses.some(
          (clause) =>
            clause.field === 'status' &&
            Array.isArray(clause.value) &&
            clause.value.includes('pending'),
        )
      ) {
        const selected = controls.afterSelection;
        controls.afterSelection = null;
        await selected();
      }
      return result;
    }

    override async manageSourceMediaImport(command: SourceMediaImportCommand) {
      if (controls.blockAfterCommit && controls.faults > 0)
        throw new Error('database unavailable after commit');
      const result = await super.manageSourceMediaImport(command);
      if (command.action === controls.phase && controls.faults === 0) {
        controls.faults++;
        throw new Error('injected actual committed operation ACK loss');
      }
      return result;
    }
  }
  class Storage extends LocalDiskMediaStorage {
    writes = 0;
    readonly deletes: string[] = [];
    override async putObject(input: PutMediaObjectInput, options?: PutMediaObjectOptions) {
      const result = await super.putObject(input, options);
      this.writes++;
      if (controls.loseUploadAck) {
        controls.loseUploadAck = false;
        throw new Error('bytes committed, upload ACK lost');
      }
      return result;
    }
    override async deleteObject(id: string) {
      this.deletes.push(id);
      const selected = controls.deleteFailureFileId === null || controls.deleteFailureFileId === id;
      const failure = selected ? controls.deleteFailure : null;
      if (selected) {
        controls.deleteFailure = null;
        controls.deleteFailureFileId = null;
      }
      if (failure === 'before') throw new Error('object delete unavailable');
      await super.deleteObject(id);
      if (failure === 'after') throw new Error('object removed, delete ACK lost');
    }
  }
  const path = join(directory, 'db.json');
  const adapter = new Adapter(path);
  const storage = new Storage(join(directory, 'media'));
  setAdapter(adapter);
  setMediaStorage(storage);
  const images = async () =>
    (await adapter.list({ collection: 'images', page: 1, pageSize: 100, search: '' })).items;
  const readable = async (id: string) => {
    const row = await adapter.get('images', id);
    assert.ok(row);
    assert.equal(row.status, 'active');
    assert.equal(typeof row.storageFileId, 'string');
    assert.equal(
      (await storage.getObjectAsBase64(String(row.storageFileId))).body,
      pixels.toString('base64'),
    );
    return row;
  };
  return { adapter, storage, controls, path, images, readable };
}
test('native source copy activates one real readable PNG and canonical website binding', async (t) => {
  const f = await workspace(t);
  const fetched: string[] = [];
  const result = await importCandidateImage('HTTPS://SC04.ALICDN.COM:443/a.png#ignored', {
    ...deps,
    fetchImpl: async (input) => {
      fetched.push(String(input));
      return deps.fetchImpl();
    },
  });
  assert.ok(result.ok);
  await f.readable(result.imageId);
  assert.deepEqual(fetched, [`${sourceUrl}#ignored`]);
  assert.equal(
    (
      await f.adapter.get(
        'catalogSourceLinks',
        sourceMediaLinkId('alibaba', `${sourceUrl}#ignored`),
      )
    )?.imageId,
    result.imageId,
  );
  assert.equal(f.storage.writes, 1);
});
for (const phase of ['claim', 'checkpoint', 'activate'] as const) {
  test(`native ${phase} commit ACK loss resolves the same actual operation without deleting bytes`, async (t) => {
    const f = await workspace(t);
    f.controls.phase = phase;
    const result = await importCandidateImage(sourceUrl, deps);
    assert.ok(result.ok);
    assert.equal(f.controls.faults, 1, 'fault reaches the real current commit seam');
    await f.readable(result.imageId);
    assert.equal((await f.images()).length, 1);
    assert.equal(f.storage.writes, 1);
    assert.deepEqual(f.storage.deletes, []);
  });
}
test('native checksum reuse commit ACK loss returns the existing image and removes its unused pending reservation', async (t) => {
  const f = await workspace(t);
  const first = await importCandidateImage(sourceUrl, deps);
  assert.ok(first.ok);
  f.controls.phase = 'reuse';
  const second = await importCandidateImage('https://sc05.alicdn.com/other.png', deps);
  assert.ok(second.ok);
  assert.equal(f.controls.faults, 1);
  assert.equal(second.imageId, first.imageId);
  await f.readable(second.imageId);
  assert.equal((await f.images()).length, 1);
  assert.equal(f.storage.writes, 1);
  assert.deepEqual(f.storage.deletes, []);
});
test('native cached URL does not fetch an unavailable supplier or allocate a pending image', async (t) => {
  const f = await workspace(t);
  const first = await importCandidateImage(sourceUrl, deps);
  assert.ok(first.ok);
  let fetched = 0;
  const second = await importCandidateImage(sourceUrl, {
    ...deps,
    fetchImpl: async () => {
      fetched++;
      return new Response('', { status: 503 });
    },
  });
  assert.ok(second.ok);
  assert.equal(second.imageId, first.imageId);
  assert.equal(fetched, 0);
  assert.equal((await f.images()).length, 1);
  await f.readable(second.imageId);
});
test('native same-URL concurrent import has one byte writer and retry reuses its finished binding', async (t) => {
  const f = await workspace(t);
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = importCandidateImage(sourceUrl, {
    ...deps,
    fetchImpl: async () => {
      entered();
      await gate;
      return deps.fetchImpl();
    },
  });
  await fetching;
  try {
    assert.deepEqual(await importCandidateImage(sourceUrl, deps), { ok: false, reason: 'busy' });
  } finally {
    release();
  }
  const completed = await first;
  assert.ok(completed.ok);
  const retry = await importCandidateImage(sourceUrl, deps);
  assert.ok(retry.ok);
  assert.equal(retry.imageId, completed.imageId);
  assert.equal((await f.images()).length, 1);
  assert.equal(f.storage.writes, 1);
  await f.readable(retry.imageId);
});
test('native expired claimant cannot upload or replace the next claimant after its delayed fetch returns', async (t) => {
  const f = await workspace(t);
  let current = '2026-10-15T00:00:00.000Z';
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = importCandidateImage(sourceUrl, {
    ...deps,
    now: () => current,
    fetchImpl: async () => {
      entered();
      await gate;
      return deps.fetchImpl();
    },
  });
  await fetching;
  current = '2026-10-15T00:03:00.000Z';
  let next: Awaited<ReturnType<typeof importCandidateImage>>;
  try {
    next = await importCandidateImage(sourceUrl, { ...deps, now: () => current });
    assert.ok(next.ok);
  } finally {
    release();
  }
  const stale = await first;
  assert.equal(stale.ok, false);
  assert.ok(next.ok);
  await f.readable(next.imageId);
  assert.equal(f.storage.writes, 1);
  assert.deepEqual(f.storage.deletes, []);
  assert.equal(
    (await f.adapter.get('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl)))?.imageId,
    next.imageId,
  );
});
test('native unknown upload result retains failed target; retry uses a fresh object without compensating either file', async (t) => {
  const f = await workspace(t);
  f.controls.loseUploadAck = true;
  const first = await importCandidateImage(sourceUrl, deps);
  assert.equal(first.ok, false);
  const failed = (await f.images()).find((row) => row.status === 'failed');
  assert.ok(failed);
  assert.equal(typeof failed.storageFileId, 'string');
  assert.equal(
    (await f.storage.getObjectAsBase64(String(failed.storageFileId))).body,
    pixels.toString('base64'),
  );
  const retry = await importCandidateImage(sourceUrl, deps);
  assert.ok(retry.ok);
  const active = await f.readable(retry.imageId);
  assert.notEqual(active.storageFileId, failed.storageFileId);
  assert.equal((await f.images()).length, 2);
  const third = await importCandidateImage('https://sc05.alicdn.com/same-after-failure.png', deps);
  assert.ok(third.ok);
  assert.equal(
    third.imageId,
    retry.imageId,
    'an older failed checksum row must not hide its healthy active copy',
  );
  assert.equal(f.storage.writes, 2);
  assert.deepEqual(f.storage.deletes, []);
});
test('native unavailable activation readback preserves active bytes and a later healthy request recovers without supplier fetch', async (t) => {
  const f = await workspace(t);
  f.controls.phase = 'activate';
  f.controls.blockAfterCommit = true;
  const first = await importCandidateImage(sourceUrl, deps);
  assert.equal(first.ok, false);
  assert.equal(f.controls.faults, 1);
  const rows = await f.images();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  await f.readable(row._id);
  assert.deepEqual(f.storage.deletes, []);
  f.controls.blockAfterCommit = false;
  let fetched = 0;
  const retry = await importCandidateImage(sourceUrl, {
    ...deps,
    fetchImpl: async () => {
      fetched++;
      throw new Error('must not fetch');
    },
  });
  assert.ok(retry.ok);
  assert.equal(retry.imageId, row._id);
  assert.equal(fetched, 0);
});
test('native delayed checkpoint response cannot begin bytes after its safe upload window', async (t) => {
  const f = await workspace(t);
  let calls = 0;
  const now = () => (++calls <= 2 ? '2026-10-15T00:00:00.000Z' : '2026-10-15T00:01:01.000Z');
  const result = await importCandidateImage(sourceUrl, { ...deps, now });
  assert.equal(result.ok, false);
  assert.equal(f.storage.writes, 0);
  const row = (await f.images())[0];
  assert.ok(row);
  assert.equal(row.status, 'failed');
  assert.equal(typeof row.storageFileId, 'string');
  await assert.rejects(f.storage.getObjectAsBase64(String(row.storageFileId)), { code: 'ENOENT' });
});

const cleanupConfig = { jwtSecret: 'source-media-owned-native-test' };
async function cleanupCaller(f: Awaited<ReturnType<typeof workspace>>) {
  await f.adapter.upsertDocWithId('users', 'admin', {
    role: 'admin',
    status: 'active',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const token = await signSession(cleanupConfig.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  return async (data: Record<string, unknown> = {}) => {
    const response = await handleAdminRequest(
      { action: 'cleanupOrphanImages', token, data },
      cleanupConfig,
    );
    assert.ok(response.ok);
    assert.ok(response.data && typeof response.data === 'object' && !Array.isArray(response.data));
    return response.data;
  };
}
for (const failure of ['before', 'after'] as const) {
  test(`native source cleanup resumes its persisted quarantine after ${failure}-delete failure`, async (t) => {
    const f = await workspace(t);
    f.controls.loseUploadAck = true;
    assert.equal(
      (await importCandidateImage(sourceUrl, { ...deps, now: () => '2026-10-01T00:00:00.000Z' }))
        .ok,
      false,
    );
    const failed = (await f.images())[0];
    assert.ok(failed);
    assert.equal(typeof failed.storageFileId, 'string');
    const call = await cleanupCaller(f);
    f.controls.deleteFailure = failure;
    const first = await call();
    const failures = Reflect.get(first, 'storageFailed');
    assert.ok(Array.isArray(failures));
    assert.equal(failures.length, 1);
    assert.deepEqual(Reflect.get(first, 'storageDeleted'), []);
    assert.equal((await f.adapter.get('images', failed._id))?.status, 'deleted');
    const fresh = new JsonFileAdapter(f.path);
    setAdapter(fresh);
    const retry = await call();
    assert.equal(Reflect.get(retry, 'docsRemoved'), 1);
    assert.deepEqual(Reflect.get(retry, 'storageDeleted'), [failed.storageFileId]);
    assert.equal(await fresh.get('images', failed._id), null);
    await assert.rejects(f.storage.getObjectAsBase64(String(failed.storageFileId)), {
      code: 'ENOENT',
    });
  });
}
test('native source retirement ACK loss is resolved before the first physical delete', async (t) => {
  const f = await workspace(t);
  f.controls.loseUploadAck = true;
  await importCandidateImage(sourceUrl, { ...deps, now: () => '2026-10-01T00:00:00.000Z' });
  const row = (await f.images())[0];
  assert.ok(row);
  const call = await cleanupCaller(f);
  f.controls.phase = 'retire';
  const result = await call();
  assert.equal(Reflect.get(result, 'docsRemoved'), 1);
  assert.equal(f.controls.faults, 1);
  assert.equal(await f.adapter.get('images', row._id), null);
  assert.equal(f.storage.deletes.length, 1);
});
test('native cleanup with an aggressive TTL keeps a failed copy until its byte-write lease expires', async (t) => {
  const f = await workspace(t);
  f.controls.loseUploadAck = true;
  await importCandidateImage(sourceUrl, deps);
  const row = (await f.images())[0];
  assert.ok(row);
  await f.adapter.update('images', row._id, { createdAt: '2020-01-01T00:00:00.000Z' });
  const call = await cleanupCaller(f);
  const result = await call({ olderThanMs: 1 });
  assert.equal(Reflect.get(result, 'docsRemoved'), 0);
  const skipped = Reflect.get(result, 'skipped');
  assert.ok(Array.isArray(skipped));
  assert.deepEqual(skipped, [{ id: row._id, reason: 'busy' }]);
  assert.equal((await f.adapter.get('images', row._id))?.status, 'failed');
  assert.deepEqual(f.storage.deletes, []);
  assert.equal(
    (await f.storage.getObjectAsBase64(String(row.storageFileId))).body,
    pixels.toString('base64'),
  );
});
test('native cleanup stale selection cannot remove a copy activated before quarantine', async (t) => {
  const f = await workspace(t);
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const copying = importCandidateImage(sourceUrl, {
    ...deps,
    now: () => '2026-10-01T00:00:00.000Z',
    fetchImpl: async () => {
      entered();
      await gate;
      return deps.fetchImpl();
    },
  });
  await started;
  f.controls.afterSelection = async () => {
    release();
    assert.ok((await copying).ok);
  };
  const call = await cleanupCaller(f);
  let result: object;
  try {
    result = await call();
  } finally {
    release();
  }
  const completed = await copying;
  assert.ok(completed.ok);
  await f.readable(completed.imageId);
  assert.equal(Reflect.get(result, 'docsRemoved'), 0);
  assert.deepEqual(Reflect.get(result, 'skipped'), [
    { id: completed.imageId, reason: 'state-changed' },
  ]);
  assert.deepEqual(f.storage.deletes, []);
});
test('native orphan cleanup merges pending and retired prefixes under one stable limit', async (t) => {
  const f = await workspace(t);
  for (const id of ['b', 'z'])
    await f.adapter.upsertDocWithId('images', id, {
      status: 'pending',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
  for (const id of ['a', 'y'])
    await f.adapter.upsertDocWithId('images', id, {
      status: 'deleted',
      uploadedByUserId: 'alibaba-catalog-sync',
      publishedRefCount: 0,
      createdAt: '2020-01-01T00:00:00.000Z',
      imageDeletion: {
        schemaVersion: 'image-deletion-v1',
        operationId: 'old-cleanup',
        uploadedByUserId: 'alibaba-catalog-sync',
        startedAt: '2020-01-01T00:00:00.000Z',
        storageProvider: '',
        storageFileIds: [],
      },
    });
  const call = await cleanupCaller(f);
  const first = await call({ limit: 2 });
  assert.equal(Reflect.get(first, 'total'), 4);
  assert.equal(Reflect.get(first, 'scanned'), 2);
  assert.deepEqual(Reflect.get(first, 'removed'), ['a', 'b']);
  const second = await call({ limit: 2 });
  assert.deepEqual(Reflect.get(second, 'removed'), ['y', 'z']);
  assert.equal((await f.images()).length, 0);
});

for (const failure of ['before', 'after'] as const) {
  test(`native checksum reuse recovers ${failure}-commit mutex release failure before returning`, async (t) => {
    const f = await workspace(t);
    const first = await importCandidateImage(sourceUrl, deps);
    assert.ok(first.ok);
    f.controls.releaseFailure = failure;
    const second = await importCandidateImage('https://sc05.alicdn.com/release-recovery.png', deps);
    assert.ok(second.ok);
    assert.equal(second.imageId, first.imageId);
    assert.equal(f.controls.releaseFaults, 1);
    const row = await f.readable(first.imageId);
    assert.equal(row.imageMutationOwner, '');
    assert.equal(row.imageMutationStartedAt, '');
  });
}

test('native retired imported image keeps both targets and reports only confirmed deletions on a partial cleanup', async (t) => {
  const f = await workspace(t);
  const files = await Promise.all(
    ['primary', 'migration'].map((fileName) =>
      f.storage.putObject({
        namespace: 'smoke',
        logicalId: fileName,
        fileName,
        mimeType: 'image/png',
        content: pixels,
      }),
    ),
  );
  const primary = files[0]?.storageFileId;
  const migration = files[1]?.storageFileId;
  assert.ok(primary && migration);
  await f.adapter.upsertDocWithId('images', 'retired-pair', {
    status: 'deleted',
    uploadedByUserId: 'alibaba-catalog-sync',
    publishedRefCount: 0,
    storageProvider: 'local-disk',
    storageFileId: primary,
    migrationStorageFileId: migration,
    createdAt: '2020-01-01T00:00:00.000Z',
    imageDeletion: {
      schemaVersion: 'image-deletion-v1',
      operationId: 'old-cleanup',
      uploadedByUserId: 'alibaba-catalog-sync',
      startedAt: '2020-01-01T00:00:00.000Z',
      storageProvider: 'local-disk',
      storageFileIds: [primary, migration],
    },
  });
  const call = await cleanupCaller(f);
  f.controls.deleteFailure = 'before';
  f.controls.deleteFailureFileId = migration;
  const first = await call();
  assert.deepEqual(Reflect.get(first, 'storageDeleted'), [primary]);
  assert.equal(Reflect.get(first, 'docsRemoved'), 0);
  assert.equal((await f.adapter.get('images', 'retired-pair'))?.status, 'deleted');
  assert.equal((await f.storage.getObjectAsBase64(migration)).body, pixels.toString('base64'));
  const retry = await call();
  assert.deepEqual(Reflect.get(retry, 'storageDeleted'), [primary, migration]);
  assert.equal(Reflect.get(retry, 'docsRemoved'), 1);
  assert.equal(await f.adapter.get('images', 'retired-pair'), null);
});

test('native active-checksum filtering precedes the one-row limit even when a newer failed row exists', async (t) => {
  const f = await workspace(t);
  const first = await importCandidateImage(sourceUrl, deps);
  assert.ok(first.ok);
  const active = await f.readable(first.imageId);
  await f.adapter.upsertDocWithId('images', 'newer-failed-checksum', {
    status: 'failed',
    checksumSha256: active.checksumSha256,
    createdAt: '2999-01-01T00:00:00.000Z',
  });
  const second = await importCandidateImage(
    'https://sc05.alicdn.com/active-under-failed.png',
    deps,
  );
  assert.ok(second.ok);
  assert.equal(second.imageId, first.imageId);
  assert.equal(f.storage.writes, 1);
  assert.equal((await f.images()).length, 2);
});

test('native failed-copy commit ACK loss preserves one failure record and no bytes', async (t) => {
  const f = await workspace(t);
  f.controls.phase = 'fail';
  const result = await importCandidateImage(sourceUrl, {
    ...deps,
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  assert.deepEqual(result, { ok: false, reason: 'not-found', failureRecorded: true });
  assert.equal(f.controls.faults, 1);
  assert.equal(f.storage.writes, 0);
  const link = await f.adapter.get('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl));
  assert.equal(link?.failureAttempts, 1);
  assert.equal(link?.failureReason, 'not-found');
});

for (const failure of ['not-owner', 'throw'] as const)
  test(`native completed source dedup recovers after repeated ${failure} release and database reopen`, async (t) => {
    const f = await workspace(t);
    const first = await importCandidateImage(sourceUrl, deps);
    assert.ok(first.ok);
    const release = f.adapter.releaseImageMutation.bind(f.adapter);
    f.adapter.releaseImageMutation = async () => {
      if (failure === 'throw') throw Error('release unavailable');
      return 'not-owner';
    };
    const url = 'https://sc05.alicdn.com/reused-after-crash.png';
    const reused = await importCandidateImage(url, deps);
    assert.ok(reused.ok && reused.imageId === first.imageId);
    assert.equal((await f.readable(first.imageId)).imageMutationOwner, '');
    const link = await f.adapter.get('catalogSourceLinks', sourceMediaLinkId('alibaba', url));
    const receipt = link?.mediaImportReceipt;
    assert.ok(receipt && typeof receipt === 'object');
    assert.equal(
      await f.adapter.acquireImageMutation(
        first.imageId,
        String(Reflect.get(receipt, 'operationId')),
        new Date().toISOString(),
      ),
      'acquired',
    );
    const locked = await f.readable(first.imageId);
    assert.ok(locked.imageMutationOwner);
    const reopened = new JsonFileAdapter(f.path);
    setAdapter(reopened);
    const recovered = await importCandidateImage(url, {
      ...deps,
      fetchImpl: async () => {
        throw Error('ready URL must not fetch again');
      },
    });
    assert.ok(recovered.ok && recovered.imageId === first.imageId);
    const current = await reopened.get('images', first.imageId);
    assert.deepEqual(current, { ...locked, imageMutationOwner: '', imageMutationStartedAt: '' });
    assert.equal(f.storage.writes, 1);
    assert.equal(
      (await reopened.list({ collection: 'images', page: 1, pageSize: 100, search: '' })).items
        .length,
      1,
    );
    assert.equal(await release(first.imageId, String(locked.imageMutationOwner)), 'not-owner');
  });

for (const kind of ['addition', 'removal', 'cancel', 'missing', 'corrupt'] as const)
  test(`actual source cleanup API preserves or deletes PNG bytes for reference state ${kind}`, async (t) => {
    const f = await workspace(t);
    f.controls.loseUploadAck = true;
    await importCandidateImage(sourceUrl, { ...deps, now: () => '2026-10-01T00:00:00.000Z' });
    const image = (await f.images())[0];
    assert.ok(image);
    const removing = kind === 'removal';
    const plan = buildCatalogImageReferencePlan(
      '1'.repeat(64),
      removing ? [image._id] : [],
      removing ? [] : [image._id],
    );
    await f.adapter.update('images', image._id, {
      publishedRefCount: removing ? 1 : 0,
      catalogPublishedReferenceLedger: {
        version: 'catalog-image-reference-ledger-v1',
        epoch: 4,
        pending: [catalogImageReferenceEntry(plan, 0)],
      },
    });
    if (kind !== 'missing') {
      const proof =
        kind === 'cancel'
          ? catalogImageReferenceCancelProof(plan.proof)
          : kind === 'corrupt'
            ? { ...plan.proof, kind: 'unknown' }
            : plan.proof;
      // Terminal proofs are exact internal rows; generic CRUD timestamps are outside their contract.
      const rows = JSON.parse(await readFile(f.path, 'utf8'));
      rows.catalogDetailApprovals ??= [];
      rows.catalogDetailApprovals.push(proof);
      await writeFile(f.path, JSON.stringify(rows));
    }
    const call = await cleanupCaller(f);
    const result = await call();
    const successful = kind === 'removal' || kind === 'cancel';
    assert.equal(Reflect.get(result, 'docsRemoved'), successful ? 1 : 0, JSON.stringify(result));
    if (successful) {
      assert.equal(await f.adapter.get('images', image._id), null);
      await assert.rejects(f.storage.getObjectAsBase64(String(image.storageFileId)), {
        code: 'ENOENT',
      });
      assert.ok(await f.adapter.get('catalogDetailApprovals', plan.proof._id));
      assert.equal(Reflect.get(await call(), 'docsRemoved'), 0);
    } else {
      assert.equal((await f.adapter.get('images', image._id))?.status, 'failed');
      assert.equal(
        (await f.storage.getObjectAsBase64(String(image.storageFileId))).body,
        pixels.toString('base64'),
      );
      assert.deepEqual(f.storage.deletes, []);
      assert.deepEqual(Reflect.get(result, 'storageDeleted'), []);
    }
  });

test('JSON source checkpoint captures nested target while queued behind the existing lock', async (t) => {
  const f = await workspace(t);
  const now = '2026-10-18T00:00:00.000Z';
  const base = { sourceUrl, operationId: 'source-op', imageId: 'source-image', now };
  assert.equal(
    (await f.adapter.manageSourceMediaImport({ ...base, action: 'claim' })).status,
    'claimed',
  );
  const object = await f.storage.putObject({
    namespace: 'smoke',
    logicalId: 'source-capture',
    fileName: 'original.png',
    mimeType: 'image/png',
    content: pixels,
  });
  const command: SourceMediaImportCommand = {
    ...base,
    action: 'checkpoint',
    target: {
      storageProvider: 'local-disk',
      storageMode: 'local-disk',
      storageFileId: object.storageFileId,
      storagePath: object.storagePath,
      byteSize: pixels.length,
      checksumSha256: createHash('sha256').update(pixels).digest('hex'),
      mimeType: 'image/png',
      name: 'original.png',
    },
  };
  const lock = Reflect.get(f.adapter, 'withMutationLock');
  assert.equal(typeof lock, 'function');
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holding = Reflect.apply(lock, f.adapter, [
    async () => {
      entered();
      await gate;
    },
  ]);
  await ready;
  const pending = f.adapter.manageSourceMediaImport(command);
  command.imageId = 'changed';
  command.target.name = 'changed.png';
  command.target.storageFileId = 'local://changed';
  release();
  await holding;
  assert.equal((await pending).status, 'checkpointed');
  const image = await new JsonFileAdapter(f.path).get('images', base.imageId);
  assert.ok(image);
  assert.equal(image.name, 'original.png');
  assert.equal(image.storageFileId, object.storageFileId);
});
