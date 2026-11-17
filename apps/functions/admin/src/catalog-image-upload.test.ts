import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { readImageUploadWebPreparation, setAdapter } from '@vibelingan-channel/db';
import { readCatalogWebImage } from '@vibelingan-channel/db/catalog-web-image';
import {
  type PutMediaObjectInput,
  type PutMediaObjectOptions,
  setMediaStorage,
} from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { z } from 'zod';
import { largeCatalogPng } from '../../../../packages/media-storage/src/catalog-image-fixtures.test-helper.ts';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { getCatalogImage } from '../../public-api/src/handler.ts';
import { handleAdminRequest } from './handler.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const success = z.object({ ok: z.literal(true), data: z.record(z.unknown()) });

class ObservedLocalStorage extends LocalDiskMediaStorage {
  webWrites = 0;
  afterWebWrite: (() => Promise<void>) | undefined;
  override async putObject(input: PutMediaObjectInput, options: PutMediaObjectOptions = {}) {
    const target = await super.putObject(input, options);
    if (input.namespace === 'catalog-web') {
      this.webWrites++;
      await this.afterWebWrite?.();
    }
    return target;
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'channel-upload-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new JsonFileAdapter(join(root, 'db.json'));
  const storage = new ObservedLocalStorage(join(root, 'media'));
  setAdapter(db);
  setMediaStorage(storage);
  const admin = await db.create('users', {
    role: 'admin',
    status: 'active',
    email: 'fixture@example.invalid',
    name: 'Test administrator',
  });
  const bytes = await largeCatalogPng();
  const originalSha = hash(bytes);
  const image = await db.create('images', {
    purpose: 'catalog-image',
    uploadedByUserId: admin._id,
    uploadIntentId: 'test-upload',
    status: 'pending',
    publishedRefCount: 0,
    name: 'Original photo',
    mimeType: 'image/png',
    byteSize: bytes.length,
    checksumSha256: originalSha,
  });
  const original = await storage.putObject(
    {
      namespace: 'catalog',
      logicalId: image._id,
      fileName: 'photo.png',
      mimeType: 'image/png',
      content: bytes,
    },
    {
      beforeWrite: async (target) => {
        await db.update('images', image._id, { ...target });
      },
    },
  );
  const secret = 'only-for-local-image-tests';
  const token = await signSession(secret, {
    sub: admin._id,
    email: 'fixture@example.invalid',
    name: 'Test administrator',
    role: 'admin',
  });
  const call = (action: string, data: Record<string, unknown>) =>
    handleAdminRequest({ action, data, token }, { jwtSecret: secret });
  return { db, storage, admin, image, bytes, original, originalSha, call };
}

test('the real local admin entry completes a large original, previews the verified web image and retains the public reference gate', async (t) => {
  const { db, storage, image, original, originalSha, call } = await fixture(t);
  const completed = success.parse(await call('completeUpload', { imageId: image._id }));
  assert.equal(completed.data.status, 'active');
  const active = await db.get('images', image._id);
  assert.ok(active);
  const web = readCatalogWebImage(active);
  assert.ok(web);
  assert.equal(active.storageFileId, original.storageFileId);
  assert.equal(active.checksumSha256, originalSha);
  assert.equal(
    (await getCatalogImage(image._id)).ok,
    false,
    'Private uploads stay invisible to visitors',
  );
  const preview = success.parse(await call('getImagePreview', { id: image._id }));
  assert.equal(preview.data.mimeType, 'image/webp');
  assert.equal(typeof preview.data.dataBase64, 'string');
  const previewBytes = Buffer.from(String(preview.data.dataBase64), 'base64');
  assert.equal(hash(previewBytes), web.checksumSha256);
  assert.ok(
    Buffer.byteLength(JSON.stringify(preview)) < 6_000_000,
    'The preview response must fit the cloud boundary',
  );
  // The public-reference state is a local fixture, not a production publication.
  await db.update('images', image._id, { publishedRefCount: 1 });
  const publicImage = await getCatalogImage(image._id);
  assert.ok(publicImage.ok && 'body' in publicImage);
  assert.equal(hash(Buffer.from(publicImage.body, 'base64')), web.checksumSha256);
  assert.equal(publicImage.headers['Content-Type'], 'image/webp');
  success.parse(await call('completeUpload', { imageId: image._id }));
  const repeated = await db.get('images', image._id);
  assert.ok(repeated);
  assert.deepEqual(readCatalogWebImage(repeated), web);
  const retained = await storage.getObjectAsBase64(original.storageFileId);
  assert.equal(hash(Buffer.from(retained.body, 'base64')), originalSha);
});

test('an unknown web PUT result retains its target and the same authenticated retry reuses bytes and later human edits', async (t) => {
  const { db, storage, image, call } = await fixture(t);
  storage.afterWebWrite = async () => {
    storage.afterWebWrite = undefined;
    await db.update('images', image._id, { customAlt: 'Human edit during preparation' });
    throw Error('The object was saved but its acknowledgement was lost');
  };
  const first = await call('completeUpload', { imageId: image._id });
  assert.ok(!first.ok);
  assert.equal(first.error.code, 'BUSY');
  const pending = await db.get('images', image._id);
  assert.ok(pending);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.catalogWebImage, undefined);
  const target = readImageUploadWebPreparation(pending);
  assert.ok(target);
  assert.equal(storage.webWrites, 1);
  const bytes = await storage.getObjectAsBase64(target.catalogWebImage.storageFileId);
  assert.equal(hash(Buffer.from(bytes.body, 'base64')), target.catalogWebImage.checksumSha256);
  success.parse(await call('completeUpload', { imageId: image._id }));
  const active = await db.get('images', image._id);
  assert.ok(active);
  assert.equal(active.customAlt, 'Human edit during preparation');
  assert.deepEqual(readCatalogWebImage(active), target.catalogWebImage);
  assert.equal(storage.webWrites, 1, 'Retry must not create or write another web image');
});

test('permission revoked during web preparation prevents activation and a later authorized retry resumes the same target', async (t) => {
  const { db, storage, admin, image, call } = await fixture(t);
  storage.afterWebWrite = async () => {
    storage.afterWebWrite = undefined;
    await db.update('users', admin._id, { status: 'suspended' });
  };
  const first = await call('completeUpload', { imageId: image._id });
  assert.ok(!first.ok);
  assert.equal(first.error.code, 'FORBIDDEN');
  const pending = await db.get('images', image._id);
  assert.ok(pending);
  assert.equal(pending.status, 'pending');
  assert.ok(readImageUploadWebPreparation(pending));
  await db.update('users', admin._id, { status: 'active' });
  success.parse(await call('completeUpload', { imageId: image._id }));
  const active = await db.get('images', image._id);
  assert.ok(active);
  assert.ok(readCatalogWebImage(active));
  assert.equal(storage.webWrites, 1);
});
