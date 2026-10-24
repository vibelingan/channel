import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { type AdapterListQuery, type ImageUploadCommand, setAdapter } from '@vibelingan-channel/db';
import { type MediaObjectReadOptions, setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=',
  'base64',
);
const config = { jwtSecret: 'upload-lifecycle-disposable-only' };
async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'channel-upload-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controls = {
    afterSelection: null as (() => Promise<void>) | null,
    readGate: null as (() => Promise<void>) | null,
    loseDeleteAck: false,
    sizeHint: null as number | null,
    rejectGate: null as (() => Promise<void>) | null,
    uploadPhase: null as ImageUploadCommand['action'] | null,
    uploadFaults: 0,
    blockUploadAfterCommit: false,
    afterRead: null as (() => Promise<void>) | null,
    unavailableOnce: false,
    bodyOverride: null as string | null,
    reads: 0,
    completedReads: 0,
    releaseCalls: 0,
    readLimits: [] as (MediaObjectReadOptions | undefined)[],
    deletes: 0,
  };
  class Adapter extends JsonFileAdapter {
    override async manageImageUpload(command: ImageUploadCommand) {
      if (command.action === 'reject' && controls.rejectGate) await controls.rejectGate();
      if (controls.blockUploadAfterCommit && controls.uploadFaults)
        throw new Error('database unavailable after activation');
      const result = await super.manageImageUpload(command);
      if (command.action === controls.uploadPhase && controls.uploadFaults === 0) {
        controls.uploadFaults++;
        throw new Error('actual commit ACK lost');
      }
      return result;
    }

    override async releaseImageMutation(imageId: string, owner: string) {
      controls.releaseCalls++;
      return super.releaseImageMutation(imageId, owner);
    }

    override async list(query: AdapterListQuery) {
      const result = await super.list(query);
      if (query.collection === 'images' && controls.afterSelection) {
        const hook = controls.afterSelection;
        controls.afterSelection = null;
        await hook();
      }
      return result;
    }
  }
  class Storage extends LocalDiskMediaStorage {
    override async getObjectAsBase64(id: string, limits?: MediaObjectReadOptions) {
      controls.readLimits.push(limits);
      controls.reads++;
      if (controls.unavailableOnce) {
        controls.unavailableOnce = false;
        throw new Error('object not readable yet');
      }

      if (controls.readGate) await controls.readGate();
      const stored = await super.getObjectAsBase64(id, limits);
      controls.completedReads++;
      const object =
        controls.bodyOverride === null ? stored : { ...stored, body: controls.bodyOverride };
      if (controls.afterRead) {
        const hook = controls.afterRead;
        controls.afterRead = null;
        await hook();
      }
      return controls.sizeHint === null ? object : { ...object, byteSize: controls.sizeHint };
    }
    override async deleteObject(id: string) {
      controls.deletes++;
      await super.deleteObject(id);
      if (controls.loseDeleteAck) {
        controls.loseDeleteAck = false;
        throw new Error('deleted but ACK lost');
      }
    }
  }
  const adapter = new Adapter(join(directory, 'db.json'));
  const storage = new Storage(join(directory, 'storage'));
  setAdapter(adapter);
  setMediaStorage(storage);
  for (const id of ['admin', 'other'])
    await adapter.upsertDocWithId('users', id, {
      role: 'admin',
      status: 'active',
      name: id,
      email: `${id}@example.test`,
    });
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'admin',
    email: 'admin@example.test',
  });
  const other = await signSession(config.jwtSecret, {
    sub: 'other',
    role: 'admin',
    name: 'other',
    email: 'other@example.test',
  });
  const target = await storage.putObject({
    namespace: 'smoke',
    logicalId: 'upload',
    fileName: 'pixel.png',
    mimeType: 'image/png',
    content: bytes,
  });
  await adapter.upsertDocWithId('images', 'upload', {
    ...target,
    status: 'pending',
    uploadedByUserId: 'admin',
    uploadIntentId: 'owned-upload',
    purpose: 'catalog-image',
    publishedRefCount: 0,
    mimeType: 'image/png',
    name: 'pixel.png',
    byteSize: bytes.length,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const call = (action: string, data: Record<string, unknown> = {}, credential = token) =>
    handleAdminRequest({ action, data, token: credential }, config);
  return { adapter, storage, target, controls, call, other };
}

test('ordinary upload activates verified bytes and remains readable', async (t) => {
  const f = await workspace(t);
  assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'active');
  assert.equal(
    (await f.storage.getObjectAsBase64(f.target.storageFileId)).body,
    bytes.toString('base64'),
  );
});
test('stale orphan selection cannot delete an upload finalized before cleanup acquires it', async (t) => {
  const f = await workspace(t);
  f.controls.afterSelection = async () => {
    assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  };
  assert.ok((await f.call('cleanupOrphanImages')).ok);
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'active');
  assert.equal(f.controls.deletes, 0);
  assert.equal(
    (await f.storage.getObjectAsBase64(f.target.storageFileId)).body,
    bytes.toString('base64'),
  );
});
test('concurrent finalizers have one byte verifier while the second returns a recoverable busy result', async (t) => {
  const f = await workspace(t);
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.controls.readGate = async () => {
    entered();
    await held;
  };
  const first = f.call('completeUpload', { imageId: 'upload' });
  await started;
  const second = f.call('completeUpload', { imageId: 'upload' });
  try {
    const outcome = await Promise.race([
      second,
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);
    assert.ok(outcome, 'loser must return before first verification is released');
    assert.ok(!outcome.ok && outcome.error.code === 'BUSY');
    assert.equal(f.controls.reads, 1);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
  assert.ok((await first).ok);
});
test('retrying a confirmed completed upload returns its existing success without rereading bytes', async (t) => {
  const f = await workspace(t);
  assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  assert.equal(f.controls.reads, 1);
});
test('another uploader cannot finalize private bytes or consume the upload', async (t) => {
  const f = await workspace(t);
  const result = await f.call('completeUpload', { imageId: 'upload' }, f.other);
  assert.ok(!result.ok && result.error.code === 'FORBIDDEN');
  assert.equal(f.controls.reads, 0);
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'pending');
});
test('orphan cleanup persists terminal state before a lost byte-delete acknowledgement and resumes it', async (t) => {
  const f = await workspace(t);
  f.controls.loseDeleteAck = true;
  assert.ok((await f.call('cleanupOrphanImages')).ok);
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'deleted');
  assert.ok((await f.call('cleanupOrphanImages')).ok);
  assert.equal(await f.adapter.get('images', 'upload'), null);
});

for (const phase of ['activate', 'reject'] as const) {
  test(`native upload ${phase} committed ACK loss replays the same result without deleting bytes`, async (t) => {
    const f = await workspace(t);
    if (phase === 'reject')
      await f.adapter.update('images', 'upload', { checksumSha256: 'a'.repeat(64) });
    f.controls.uploadPhase = phase;
    const result = await f.call('completeUpload', { imageId: 'upload' });
    assert.equal(f.controls.uploadFaults, 1);
    if (phase === 'activate') assert.ok(result.ok);
    else assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR');
    assert.equal(
      (await f.adapter.get('images', 'upload'))?.status,
      phase === 'activate' ? 'active' : 'failed',
    );
    assert.equal(f.controls.reads, 1);
    assert.equal(f.controls.deletes, 0);
  });
}
test('temporarily unreadable upload releases the mutex and the same upload can finish later', async (t) => {
  const f = await workspace(t);
  f.controls.unavailableOnce = true;
  const first = await f.call('completeUpload', { imageId: 'upload' });
  assert.ok(!first.ok && first.error.code === 'NOT_FOUND');
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'pending');
  assert.equal((await f.adapter.get('images', 'upload'))?.imageMutationOwner, '');
  assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  assert.equal(f.controls.deletes, 0);
});
test('activation with unavailable confirmation retains its completion receipt for a later retry', async (t) => {
  const f = await workspace(t);
  f.controls.uploadPhase = 'activate';
  f.controls.blockUploadAfterCommit = true;
  const first = await f.call('completeUpload', { imageId: 'upload' });
  assert.equal(first.ok, false);
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'active');
  f.controls.blockUploadAfterCommit = false;
  assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  assert.equal(f.controls.reads, 1);
  assert.equal(f.controls.deletes, 0);
});
test('cleanup while byte verification is held skips its fresh image mutex and cannot remove bytes', async (t) => {
  const f = await workspace(t);
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.controls.readGate = async () => {
    entered();
    await held;
  };
  const completing = f.call('completeUpload', { imageId: 'upload' });
  await started;
  try {
    const cleaned = await f.call('cleanupOrphanImages');
    assert.ok(cleaned.ok);
    assert.equal(f.controls.deletes, 0);
    assert.equal((await f.adapter.get('images', 'upload'))?.status, 'pending');
  } finally {
    release();
    await Promise.allSettled([completing]);
  }
  assert.ok((await completing).ok);
});
test('changing an upload target during byte verification fences the final write and preserves both objects', async (t) => {
  const f = await workspace(t);
  const replacement = await f.storage.putObject({
    namespace: 'smoke',
    logicalId: 'replacement',
    fileName: 'other.png',
    mimeType: 'image/png',
    content: bytes,
  });
  f.controls.afterRead = () =>
    f.adapter
      .update('images', 'upload', { storageFileId: replacement.storageFileId })
      .then(() => {});
  const result = await f.call('completeUpload', { imageId: 'upload' });
  assert.ok(!result.ok && result.error.code === 'CONFLICT');
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'pending');
  assert.equal(f.controls.deletes, 0);
  assert.equal(
    (await f.storage.getObjectAsBase64(f.target.storageFileId)).body,
    bytes.toString('base64'),
  );
  assert.equal(
    (await f.storage.getObjectAsBase64(replacement.storageFileId)).body,
    bytes.toString('base64'),
  );
});
test('a revoked uploader cannot commit activation after its byte read', async (t) => {
  const f = await workspace(t);
  f.controls.afterRead = () =>
    f.adapter.update('users', 'admin', { role: 'viewer' }).then(() => {});
  const result = await f.call('completeUpload', { imageId: 'upload' });
  assert.ok(!result.ok && result.error.code === 'FORBIDDEN');
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'pending');
  assert.equal(f.controls.deletes, 0);
});
test('an unknown completion receipt cannot grant successful retry', async (t) => {
  const f = await workspace(t);
  assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  await f.adapter.update('images', 'upload', {
    imageUploadCompletion: { schemaVersion: 'image-upload-completion-v2' },
  });
  const retry = await f.call('completeUpload', { imageId: 'upload' });
  assert.ok(!retry.ok && retry.error.code === 'CONFLICT');
  assert.equal(f.controls.reads, 1);
});
test('an understated adapter size cannot allow over-cap actual upload bytes', async (t) => {
  const f = await workspace(t);
  const oversized = Buffer.concat([bytes, Buffer.alloc(10 * 1024 * 1024)]);
  const target = await f.storage.putObject({
    namespace: 'smoke',
    logicalId: 'oversize',
    fileName: 'large.png',
    mimeType: 'image/png',
    content: oversized,
  });
  await f.adapter.update('images', 'upload', {
    storageFileId: target.storageFileId,
    checksumSha256: createHash('sha256').update(oversized).digest('hex'),
  });
  f.controls.sizeHint = 1;
  const result = await f.call('completeUpload', { imageId: 'upload' });
  assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR');
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'failed');
  assert.equal(f.controls.deletes, 0);
});
test('ownerless legacy pending metadata can be quarantined and cleaned without inventing an uploader', async (t) => {
  const f = await workspace(t);
  await f.adapter.upsertDocWithId('images', 'legacy-empty', {
    status: 'pending',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  assert.ok((await f.call('cleanupOrphanImages')).ok);
  assert.equal(await f.adapter.get('images', 'legacy-empty'), null);
});

for (const failure of ['base64', 'mime'] as const)
  test(`native malformed ${failure} cannot activate valid-looking upload metadata`, async (t) => {
    const f = await workspace(t);
    if (failure === 'base64') f.controls.bodyOverride = `${bytes.toString('base64')}!`;
    else {
      const html = Buffer.from('<html>invalid image</html>');
      f.controls.bodyOverride = html.toString('base64');
      await f.adapter.update('images', 'upload', {
        checksumSha256: createHash('sha256').update(html).digest('hex'),
      });
    }
    const result = await f.call('completeUpload', { imageId: 'upload' });
    assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR');
    const row = await f.adapter.get('images', 'upload');
    assert.equal(row?.status, 'failed');
    assert.equal(row?.storageFileId, f.target.storageFileId);
    assert.equal(f.controls.deletes, 0);
  });

test('a delayed rejection write keeps its mutex until persistence completes', async (t) => {
  const f = await workspace(t);
  await f.adapter.update('images', 'upload', { checksumSha256: 'a'.repeat(64) });
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.controls.rejectGate = async () => {
    entered();
    await held;
  };
  const request = f.call('completeUpload', { imageId: 'upload' });
  await started;
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(
      (await f.adapter.get('images', 'upload'))?.imageMutationOwner,
      'rejection must still own the mutex before persistence starts',
    );
    assert.ok((await f.call('cleanupOrphanImages')).ok);
    assert.equal(f.controls.deletes, 0);
  } finally {
    release();
    await Promise.allSettled([request]);
  }
  const result = await request;
  assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR');
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'failed');
});

for (const refs of [0, 2])
  test(`legacy active direct upload rechecks bytes once and preserves ${refs} published references`, async (t) => {
    const f = await workspace(t);
    await f.adapter.update('images', 'upload', { status: 'active', publishedRefCount: refs });
    assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
    assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
    const row = await f.adapter.get('images', 'upload');
    assert.equal(row?.status, 'active');
    assert.equal(row?.publishedRefCount, refs);
    assert.equal(row?.storageFileId, f.target.storageFileId);
    assert.equal(f.controls.reads, 1);
    assert.equal(f.controls.deletes, 0);
  });
test('unhealthy legacy active upload remains intact and gets an explicit replacement fallback', async (t) => {
  const f = await workspace(t);
  await f.adapter.update('images', 'upload', { status: 'active', publishedRefCount: 2 });
  f.controls.bodyOverride = Buffer.from('<html>changed stored content</html>').toString('base64');
  const result = await f.call('completeUpload', { imageId: 'upload' });
  assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR');
  const row = await f.adapter.get('images', 'upload');
  assert.equal(row?.status, 'active');
  assert.equal(row?.publishedRefCount, 2);
  assert.equal(row?.storageFileId, f.target.storageFileId);
  assert.equal(row?.imageUploadCompletion, undefined);
  assert.equal(f.controls.deletes, 0);
});

test('ordinary upload completion requests a bounded storage read', async (t) => {
  const f = await workspace(t);
  assert.ok((await f.call('completeUpload', { imageId: 'upload' })).ok);
  assert.deepEqual(f.controls.readLimits, [{ maxBytes: 10 * 1024 * 1024, timeoutMs: 5000 }]);
});
test('a physically oversized uploaded object is rejected before an adapter body is returned', async (t) => {
  const f = await workspace(t);
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  bytes.copy(oversized);
  const same = await f.storage.putObject({
    namespace: 'smoke',
    logicalId: 'upload',
    fileName: 'pixel.png',
    mimeType: 'image/png',
    content: oversized,
  });
  assert.equal(same.storageFileId, f.target.storageFileId);
  const result = await f.call('completeUpload', { imageId: 'upload' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'VALIDATION_ERROR');
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'failed');
  assert.equal((await f.adapter.get('images', 'upload'))?.storageFileId, f.target.storageFileId);
  assert.equal(f.controls.completedReads, 0);
  assert.equal(f.controls.deletes, 0);
});

test('a capped physical upload keeps its mutex until rejection has committed', async (t) => {
  const f = await workspace(t);
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  bytes.copy(oversized);
  await f.storage.putObject({
    namespace: 'smoke',
    logicalId: 'upload',
    fileName: 'pixel.png',
    mimeType: 'image/png',
    content: oversized,
  });
  let entered = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.controls.rejectGate = async () => {
    entered = true;
    await gate;
  };
  const finishing = f.call('completeUpload', { imageId: 'upload' });
  try {
    for (let i = 0; i < 100 && !entered; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(entered);
    assert.equal(f.controls.releaseCalls, 0);
    assert.ok((await f.adapter.get('images', 'upload'))?.imageMutationOwner);
  } finally {
    release();
    await finishing;
  }
  assert.equal(f.controls.releaseCalls, 1);
  assert.equal((await f.adapter.get('images', 'upload'))?.status, 'failed');
});
