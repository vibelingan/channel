import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { commentedAnimation, largeCatalogPng } from './catalog-image-fixtures.test-helper.ts';
import { prepareCatalogWebObject } from './catalog-web-prepare.ts';
import { MediaReadError, type MediaStorageAdapter, objectStoragePath } from './index.ts';
import { decodeCatalogImagePixels } from './pixels.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const largeSource = largeCatalogPng;

function storage() {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  let corruptRead = false;
  const port: Pick<MediaStorageAdapter, 'putObject' | 'getObjectAsBase64'> = {
    async putObject(input, options = {}) {
      const path = objectStoragePath(input);
      const target = {
        storageProvider: 'local-disk' as const,
        storageMode: 'local-disk' as const,
        storageFileId: `local-disk:${path}`,
        storagePath: path,
      };
      await options.beforeWrite?.(target);
      assert.ok(input.content instanceof Uint8Array);
      calls.push('write');
      objects.set(target.storageFileId, Buffer.from(input.content));
      return target;
    },
    async getObjectAsBase64(id) {
      calls.push('read');
      const bytes = objects.get(id);
      if (!bytes) throw new MediaReadError('unavailable');
      return { body: (corruptRead ? Buffer.from('corrupted') : bytes).toString('base64') };
    },
  };
  return {
    port,
    objects,
    calls,
    corrupt() {
      corruptRead = true;
    },
  };
}

test('a real oversized original gets a checkpointed, read-back verified web object while its bytes stay unchanged', async () => {
  const bytes = await largeSource();
  assert(bytes.length > 4_000_000);
  const hash = sha(bytes);
  const f = storage();
  let checkpoints = 0;
  const result = await prepareCatalogWebObject({
    imageId: 'original-image',
    bytes,
    mimeType: 'image/png',
    checksumSha256: hash,
    storage: f.port,
    checkpoint: async () => {
      checkpoints++;
      assert.deepEqual(f.calls, [], 'Checkpoint precedes object bytes');
    },
  });
  assert.ok(result, 'Oversized originals must not bypass web preparation');
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert(result.byteSize <= 3_000_000);
  assert.equal(checkpoints, 1);
  assert.deepEqual(f.calls, ['write', 'read']);
  assert.equal(sha(bytes), hash);
  const saved = f.objects.get(result.storageFileId);
  assert.ok(saved);
  assert.equal(sha(saved), result.checksumSha256);
});

test('a rejected durable checkpoint prevents any new object bytes', async () => {
  const bytes = await largeSource();
  const f = storage();
  await assert.rejects(
    prepareCatalogWebObject({
      imageId: 'private-image',
      bytes,
      mimeType: 'image/png',
      checksumSha256: sha(bytes),
      storage: f.port,
      checkpoint: async () => {
        throw Error('Lost image owner');
      },
    }),
    /Lost image owner/,
  );
  assert.deepEqual(f.calls, []);
});

test('read-back corruption cannot produce a ready web object', async () => {
  const bytes = await largeSource();
  const f = storage();
  f.corrupt();
  await assert.rejects(
    prepareCatalogWebObject({
      imageId: 'private-image',
      bytes,
      mimeType: 'image/png',
      checksumSha256: sha(bytes),
      storage: f.port,
      checkpoint: async () => {},
    }),
    /bytes|size|digest/i,
  );
  assert.deepEqual(f.calls, ['write', 'read']);
});

test('a retry reuses verified planned bytes and an unknown previous PUT retries only the same immutable target', async () => {
  const bytes = await largeSource();
  const f = storage();
  const source = {
    imageId: 'same-image',
    bytes,
    mimeType: 'image/png',
    checksumSha256: sha(bytes),
  };
  const existing = await prepareCatalogWebObject({
    ...source,
    storage: f.port,
    checkpoint: async () => {},
  });
  assert.ok(existing);
  f.calls.length = 0;
  assert.deepEqual(
    await prepareCatalogWebObject({
      ...source,
      storage: f.port,
      existing,
      checkpoint: async () => {
        throw Error('A ready retry must not begin another PUT');
      },
    }),
    existing,
  );
  assert.deepEqual(f.calls, ['read']);
  const missing = storage();
  let intended: unknown;
  assert.deepEqual(
    await prepareCatalogWebObject({
      ...source,
      storage: missing.port,
      existing,
      checkpoint: async (target) => {
        intended = target;
      },
    }),
    existing,
  );
  assert.deepEqual(intended, existing);
  assert.deepEqual(missing.calls, ['read', 'write', 'read']);
  assert.equal(missing.objects.size, 1);
});

test('animated originals retain every frame and an oversized animation never becomes a flattened web image', async () => {
  const f = storage();
  const small = await commentedAnimation(150_000);
  const pixels = await decodeCatalogImagePixels(small, 'image/gif');
  assert.ok(pixels.status === 'decoded');
  assert.equal(pixels.pages, 2);
  assert.equal(
    await prepareCatalogWebObject({
      imageId: 'animated',
      bytes: small,
      checksumSha256: sha(small),
      mimeType: 'image/gif',
      storage: f.port,
      checkpoint: async () => {},
    }),
    null,
  );
  const large = await commentedAnimation(4_000_001);
  const original = sha(large);
  await assert.rejects(
    prepareCatalogWebObject({
      imageId: 'large-animation',
      bytes: large,
      checksumSha256: original,
      mimeType: 'image/gif',
      storage: f.port,
      checkpoint: async () => {},
    }),
    /frames/,
  );
  assert.equal(sha(large), original);
  assert.deepEqual(f.calls, []);
});
