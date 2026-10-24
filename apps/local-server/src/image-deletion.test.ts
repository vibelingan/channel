import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { executeImageDeletion, setAdapter } from '@vibelingan-channel/db';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from '../../../packages/db/src/catalog-image-references.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const now = '2026-10-15T00:00:00.000Z';
const begin = {
  action: 'begin',
  imageId: 'i',
  uploadedByUserId: 'u',
  owner: 'op',
  startedAt: now,
} as const;
const config = { jwtSecret: 'image-deletion-local-only' };
async function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-image-deletion-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(join(directory, 'storage'));
  const files = await Promise.all(
    ['one', 'two'].map((name) =>
      storage.putObject({
        namespace: 'smoke',
        logicalId: name,
        fileName: `${name}.png`,
        mimeType: 'image/png',
        content: Buffer.from(name),
      }),
    ),
  );
  const primary = files[0]?.storageFileId;
  const secondary = files[1]?.storageFileId;
  assert.ok(primary && secondary);
  const path = join(directory, 'db.json');
  writeFileSync(
    path,
    JSON.stringify({
      users: ['u', 'other'].map((id) => ({
        _id: id,
        role: 'admin',
        name: id,
        email: `${id}@example.test`,
        status: 'active',
      })),
      images: [
        {
          _id: 'i',
          status: 'active',
          uploadedByUserId: 'u',
          publishedRefCount: 0,
          mimeType: 'image/png',
          storageProvider: 'local-disk',
          storageFileId: primary,
          migrationStorageFileId: secondary,
          imageMutationOwner: 'op',
          imageMutationStartedAt: now,
        },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(path);
  setAdapter(adapter);
  setMediaStorage(storage);
  return { directory, path, adapter, storage, primary, secondary };
}

test('native persisted quarantine survives restart, refuses private preview and another uploader, and resumes immediately', async (t) => {
  const f = await workspace(t);
  assert.equal((await f.adapter.manageImageDeletion(begin)).status, 'ready');
  const adapter = new JsonFileAdapter(f.path);
  setAdapter(adapter);
  const token = await signSession(config.jwtSecret, {
    sub: 'u',
    role: 'admin',
    name: 'u',
    email: 'u@example.test',
  });
  const other = await signSession(config.jwtSecret, {
    sub: 'other',
    role: 'admin',
    name: 'other',
    email: 'other@example.test',
  });
  const call = (action: string, data: Record<string, unknown>, credential = token) =>
    handleAdminRequest({ action, data, token: credential }, config);
  assert.equal((await call('getImagePreview', { id: 'i' })).ok, false);
  const forbidden = await call('abandonUpload', { imageId: 'i' }, other);
  assert.ok(!forbidden.ok && forbidden.error.code === 'FORBIDDEN');
  assert.equal((await call('abandonUpload', { imageId: 'i' })).ok, true);
  assert.equal(await adapter.get('images', 'i'), null);
  await assert.rejects(f.storage.getObjectAsBase64(f.primary), { code: 'ENOENT' });
  await assert.rejects(f.storage.getObjectAsBase64(f.secondary), { code: 'ENOENT' });
  assert.equal((await call('abandonUpload', { imageId: 'i' })).ok, true);
});

test('native partial file deletion is recoverable through a fresh adapter without resurrecting the image', async (t) => {
  const f = await workspace(t);
  const first = await executeImageDeletion(
    { manage: (c) => f.adapter.manageImageDeletion(c), get: (id) => f.adapter.get('images', id) },
    begin,
    async (id) => {
      if (id === f.secondary) throw new Error('second file unavailable');
      await f.storage.deleteObject(id);
    },
  );
  assert.equal(first, 'failed');
  await assert.rejects(f.storage.getObjectAsBase64(f.primary), { code: 'ENOENT' });
  assert.equal(
    (await f.storage.getObjectAsBase64(f.secondary)).body,
    Buffer.from('two').toString('base64'),
  );
  const adapter = new JsonFileAdapter(f.path);
  assert.equal((await adapter.get('images', 'i'))?.status, 'deleted');
  assert.equal(
    await executeImageDeletion(
      { manage: (c) => adapter.manageImageDeletion(c), get: (id) => adapter.get('images', id) },
      { ...begin, owner: 'fresh' },
      (id) => f.storage.deleteObject(id),
    ),
    'deleted',
  );
  assert.equal(await adapter.get('images', 'i'), null);
  await assert.rejects(f.storage.getObjectAsBase64(f.secondary), { code: 'ENOENT' });
});

for (const phase of ['begin', 'finish'] as const)
  test(`native ${phase} atomic rename failure preserves the previous durable image state`, async (t) => {
    const f = await workspace(t);
    if (phase === 'finish') await f.adapter.manageImageDeletion(begin);
    const previous = readFileSync(f.path, 'utf8');
    const command =
      phase === 'begin'
        ? begin
        : ({ action: 'finish', imageId: 'i', uploadedByUserId: 'u', operationId: 'op' } as const);
    const failed = f.adapter.manageImageDeletion(command);
    await Promise.resolve();
    const backup = join(f.directory, 'backup.json');
    renameSync(f.path, backup);
    mkdirSync(f.path);
    try {
      await assert.rejects(
        failed,
        (error) => error instanceof Error && 'syscall' in error && error.syscall === 'rename',
      );
    } finally {
      rmSync(f.path, { recursive: true });
      renameSync(backup, f.path);
    }
    assert.equal(readFileSync(f.path, 'utf8'), previous);
    assert.equal(
      (await f.adapter.get('images', 'i'))?.status,
      phase === 'begin' ? 'active' : 'deleted',
    );
    assert.equal(
      (await f.adapter.manageImageDeletion(command)).status,
      phase === 'begin' ? 'ready' : 'removed',
    );
  });

test('a quarantined migrated image cannot fall back to retained legacy preview bytes', async (t) => {
  const f = await workspace(t);
  await f.adapter.update('images', 'i', {
    data: Buffer.from('retained-legacy').toString('base64'),
  });
  const token = await signSession(config.jwtSecret, {
    sub: 'u',
    role: 'admin',
    name: 'u',
    email: 'u@example.test',
  });
  const preview = () =>
    handleAdminRequest({ action: 'getImagePreview', data: { id: 'i' }, token }, config);
  assert.equal((await preview()).ok, true);
  await f.adapter.manageImageDeletion(begin);
  const result = await preview();
  assert.ok(!result.ok && result.error.code === 'NOT_FOUND');
});

test('legacy migration cannot add a new storage target after durable quarantine', async (t) => {
  const f = await workspace(t);
  await f.adapter.update('images', 'i', {
    data: Buffer.from('legacy-pixels').toString('base64'),
    migrationStorageFileId: '',
  });
  await f.adapter.manageImageDeletion(begin);
  const token = await signSession(config.jwtSecret, {
    sub: 'u',
    role: 'admin',
    name: 'u',
    email: 'u@example.test',
  });
  const result = await handleAdminRequest(
    { action: 'migrateLegacyImages', data: {}, token },
    config,
  );
  assert.ok(result.ok);
  assert.ok(result.data && typeof result.data === 'object');
  assert.deepEqual(Reflect.get(result.data, 'migrated'), []);
  assert.equal((await f.adapter.get('images', 'i'))?.migrationStorageFileId, '');
  assert.equal(
    await executeImageDeletion(
      { manage: (c) => f.adapter.manageImageDeletion(c), get: (id) => f.adapter.get('images', id) },
      begin,
      (id) => f.storage.deleteObject(id),
    ),
    'deleted',
  );
});

test('migration holds the existing image mutex through staging and releases it for later abandonment', async (t) => {
  const f = await workspace(t);
  await f.adapter.update('images', 'i', {
    data: Buffer.from('legacy-pixels').toString('base64'),
    migrationStorageFileId: '',
  });
  assert.equal(await f.adapter.releaseImageMutation('i', 'op'), 'released');
  let signal: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = f.storage.putObject.bind(f.storage);
  f.storage.putObject = async (input) => {
    signal?.();
    await resume;
    return put(input);
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'u',
    role: 'admin',
    name: 'u',
    email: 'u@example.test',
  });
  const call = (action: string, data: Record<string, unknown>) =>
    handleAdminRequest({ action, data, token }, config);
  const migration = call('migrateLegacyImages', {});
  await started;
  try {
    const blocked = await call('abandonUpload', { imageId: 'i' });
    assert.ok(!blocked.ok && blocked.error.code === 'BUSY');
  } finally {
    release?.();
  }
  const result = await migration;
  assert.ok(result.ok);
  assert.ok(result.data && typeof result.data === 'object');
  assert.deepEqual(Reflect.get(result.data, 'migrated'), ['i']);
  const staged = await f.adapter.get('images', 'i');
  assert.ok(staged && typeof staged.migrationStorageFileId === 'string');
  assert.equal(staged.imageMutationOwner, '');
  assert.equal((await call('abandonUpload', { imageId: 'i' })).ok, true);
  assert.equal(await f.adapter.get('images', 'i'), null);
  await assert.rejects(f.storage.getObjectAsBase64(staged.migrationStorageFileId), {
    code: 'ENOENT',
  });
});

test('native deletion preserves spaces inside an opaque legacy storage identifier', async (t) => {
  const f = await workspace(t);
  const storageFileId = 'local-disk:legacy key ';
  writeFileSync(join(f.directory, 'storage', 'legacy key '), 'original');
  await f.adapter.update('images', 'i', { storageFileId, migrationStorageFileId: '' });
  assert.equal(
    (await f.storage.getObjectAsBase64(storageFileId)).body,
    Buffer.from('original').toString('base64'),
  );
  assert.equal(
    await executeImageDeletion(
      { manage: (c) => f.adapter.manageImageDeletion(c), get: (id) => f.adapter.get('images', id) },
      begin,
      (id) => f.storage.deleteObject(id),
    ),
    'deleted',
  );
  assert.equal(await f.adapter.get('images', 'i'), null);
  await assert.rejects(f.storage.getObjectAsBase64(storageFileId), { code: 'ENOENT' });
});

for (const kind of ['addition', 'removal', 'cancel', 'missing', 'corrupt'] as const)
  test(`admin abandonment uses complete reference state ${kind} and preserves or deletes actual bytes`, async (t) => {
    const f = await workspace(t);
    const before = JSON.parse(readFileSync(f.path, 'utf8'));
    const image = before.images[0];
    const removing = kind === 'removal';
    const plan = buildCatalogImageReferencePlan(
      '1'.repeat(64),
      removing ? ['i'] : [],
      removing ? [] : ['i'],
    );
    image.publishedRefCount = removing ? 1 : 0;
    image.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: [catalogImageReferenceEntry(plan, 0)],
    };
    before.catalogDetailApprovals =
      kind === 'missing'
        ? []
        : [
            kind === 'cancel'
              ? catalogImageReferenceCancelProof(plan.proof)
              : kind === 'corrupt'
                ? { ...plan.proof, kind: 'unknown' }
                : plan.proof,
          ];
    writeFileSync(f.path, JSON.stringify(before));
    const adapter = new JsonFileAdapter(f.path);
    setAdapter(adapter);
    const token = await signSession(config.jwtSecret, {
      sub: 'u',
      role: 'admin',
      name: 'u',
      email: 'u@example.test',
    });
    const response = await handleAdminRequest(
      { action: 'abandonUpload', token, data: { imageId: 'i' } },
      config,
    );
    if (kind === 'removal' || kind === 'cancel') {
      assert.ok(response.ok, JSON.stringify(response));
      assert.equal(await adapter.get('images', 'i'), null);
      await assert.rejects(f.storage.getObjectAsBase64(f.primary), { code: 'ENOENT' });
      await assert.rejects(f.storage.getObjectAsBase64(f.secondary), { code: 'ENOENT' });
      assert.equal(
        (
          await handleAdminRequest(
            { action: 'abandonUpload', token, data: { imageId: 'i' } },
            config,
          )
        ).ok,
        true,
      );
    } else {
      assert.ok(!response.ok);
      assert.equal(response.error.code, 'CONFLICT');
      assert.equal((await adapter.get('images', 'i'))?.status, 'active');
      assert.equal(
        (await f.storage.getObjectAsBase64(f.primary)).body,
        Buffer.from('one').toString('base64'),
      );
      assert.equal(
        (await f.storage.getObjectAsBase64(f.secondary)).body,
        Buffer.from('two').toString('base64'),
      );
    }
  });

test('JSON deletion captures its original command while queued behind the existing file lock', async (t) => {
  const f = await workspace(t);
  const rows = JSON.parse(readFileSync(f.path, 'utf8'));
  const plan = buildCatalogImageReferencePlan('1'.repeat(64), ['i'], []);
  rows.images[0].publishedRefCount = 1;
  rows.images[0].catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: [catalogImageReferenceEntry(plan, 0)],
  };
  rows.catalogDetailApprovals = [plan.proof];
  writeFileSync(f.path, JSON.stringify(rows));
  const adapter = new JsonFileAdapter(f.path);
  const lock = Reflect.get(adapter, 'withMutationLock');
  assert.equal(typeof lock, 'function');
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holding = Reflect.apply(lock, adapter, [
    async () => {
      entered();
      await gate;
    },
  ]);
  await ready;
  const command: Parameters<JsonFileAdapter['manageImageDeletion']>[0] = { ...begin };
  const pending = adapter.manageImageDeletion(command);
  command.imageId = 'other';
  command.owner = 'other';
  command.uploadedByUserId = 'other';
  release();
  await holding;
  assert.equal((await pending).status, 'ready');
  assert.equal((await new JsonFileAdapter(f.path).get('images', 'i'))?.status, 'deleted');
});
