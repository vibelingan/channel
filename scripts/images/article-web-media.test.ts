import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ActiveArticleMedia } from '../../packages/articles/src/media.ts';
import type { ArticleWebMediaReady } from '../../packages/articles/src/web-media.ts';
import {
  type StoredMediaObject,
  objectStoragePath,
} from '../../packages/media-storage/src/index.ts';
import { decodeCatalogImagePixels } from '../../packages/media-storage/src/pixels.ts';
import { prepareArticleWebMedia } from './article-web-media.ts';

async function fixture() {
  const bytes = await readFile(
    new URL('../../apps/site/public/media/factory-oem.webp', import.meta.url),
  );
  const pixels = await decodeCatalogImagePixels(bytes, 'image/webp');
  assert.equal(pixels.status, 'decoded');
  if (pixels.status !== 'decoded') throw Error('Fixture decode failed');
  const path = 'articles/2026/11/test-original/original.webp';
  const image: ActiveArticleMedia = {
    id: 'web-image',
    articleId: 'article-web-test',
    status: 'active',
    purpose: 'article-image',
    fileName: 'Original.webp',
    mimeType: 'image/webp',
    byteSize: bytes.length,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    requestHash: 'a'.repeat(64),
    createdBy: 'test-admin',
    createdAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-17T00:00:00.000Z',
    pendingStorage: {
      storageFileId: 'cloud://fixture/articles/pending',
      storagePath: 'articles/pending',
    },
    storage: { storageFileId: `cloud://fixture/${path}`, storagePath: path },
    width: pixels.width,
    height: pixels.height,
  };
  const objects = new Map([[image.storage.storageFileId, bytes]]);
  const calls = { reads: 0, writes: 0, checkpoints: 0, registrations: 0 };
  let registered: ArticleWebMediaReady | undefined;
  const input = {
    active: image,
    storage: {
      async getObjectAsBase64(id: string) {
        calls.reads++;
        const value = objects.get(id);
        if (!value) throw Error('Object missing');
        return { body: value.toString('base64') };
      },
      async putObject(
        value: {
          namespace: 'articles';
          logicalId: string;
          fileName: string;
          mimeType: string;
          content: Uint8Array;
        },
        options: { beforeWrite: (target: StoredMediaObject) => Promise<void> },
      ) {
        const storagePath = objectStoragePath(value);
        const target: StoredMediaObject = {
          storageProvider: 'cloudbase-storage',
          storageMode: 'classic-nosql-storage',
          storagePath,
          storageFileId: `cloud://fixture/${storagePath}`,
          byteSize: value.content.length,
        };
        await options.beforeWrite(target);
        calls.writes++;
        objects.set(target.storageFileId, Buffer.from(value.content));
        return target;
      },
    },
    async checkpoint() {
      calls.checkpoints++;
    },
    async register(entry: ArticleWebMediaReady): Promise<'registered' | 'unchanged'> {
      calls.registrations++;
      registered = entry;
      return 'registered';
    },
  };
  return { input, image, calls, objects, registered: () => registered };
}

test('real image preparation verifies upload and complete readback before registering', async () => {
  const f = await fixture();
  const before = structuredClone(f.image);
  const result = await prepareArticleWebMedia(f.input);
  assert.equal(result.status, 'registered');
  assert.deepEqual(f.calls, { reads: 2, writes: 1, checkpoints: 1, registrations: 1 });
  assert.deepEqual(f.image, before);
  const registered = f.registered();
  assert(registered);
  assert.notEqual(registered.web.storageFileId, f.image.storage.storageFileId);
  assert.equal(registered.source.checksumSha256, f.image.checksumSha256);
  assert.equal(registered.web.mimeType, 'image/webp');
});

test('a source mismatch stops before uploading or registering', async () => {
  const f = await fixture();
  f.image.checksumSha256 = 'f'.repeat(64);
  await assert.rejects(prepareArticleWebMedia(f.input), /source/i);
  assert.deepEqual(f.calls, { reads: 1, writes: 0, checkpoints: 0, registrations: 0 });
});

test('failed durable checkpoint prevents the object write', async () => {
  const f = await fixture();
  f.input.checkpoint = async () => {
    f.calls.checkpoints++;
    throw Error('Checkpoint unavailable');
  };
  await assert.rejects(prepareArticleWebMedia(f.input), /Checkpoint unavailable/);
  assert.deepEqual(f.calls, { reads: 1, writes: 0, checkpoints: 1, registrations: 0 });
});

test('corrupt uploaded bytes do not become ready', async () => {
  const f = await fixture();
  const get = f.input.storage.getObjectAsBase64;
  f.input.storage.getObjectAsBase64 = async (id) => {
    if (id === f.image.storage.storageFileId) return get(id);
    f.calls.reads++;
    return { body: Buffer.from('not-an-image').toString('base64') };
  };
  await assert.rejects(prepareArticleWebMedia(f.input), /readback/i);
  assert.equal(f.calls.writes, 1);
  assert.equal(f.calls.registrations, 0);
});

test('an unconfirmed upload retains its durable target and does not register or retry', async () => {
  const f = await fixture();
  const put = f.input.storage.putObject;
  f.input.storage.putObject = async (value, options) => {
    await put(value, options);
    throw Error('Unconfirmed upload');
  };
  await assert.rejects(prepareArticleWebMedia(f.input), /Unconfirmed upload/);
  assert.deepEqual(f.calls, { reads: 1, writes: 1, checkpoints: 1, registrations: 0 });
  assert.equal(f.objects.size, 2);
});

test('a ready retry rechecks registration without reading or uploading bytes again', async () => {
  const f = await fixture();
  await prepareArticleWebMedia(f.input);
  const ready = f.registered();
  assert(ready);
  f.calls.reads = f.calls.writes = f.calls.checkpoints = f.calls.registrations = 0;
  f.input.register = async () => {
    f.calls.registrations++;
    return 'unchanged';
  };
  const result = await prepareArticleWebMedia({ ...f.input, existing: ready });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(f.calls, { reads: 0, writes: 0, checkpoints: 0, registrations: 1 });
});

test('a current-source conflict at registration keeps the saved object for investigation', async () => {
  const f = await fixture();
  f.input.register = async () => {
    f.calls.registrations++;
    throw Error('Source changed');
  };
  await assert.rejects(prepareArticleWebMedia(f.input), /Source changed/);
  assert.equal(f.calls.writes, 1);
  assert.equal(f.calls.reads, 2);
  assert.equal(f.objects.size, 2);
});
