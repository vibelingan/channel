import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { commentedAnimation, largeCatalogPng } from './catalog-image-fixtures.test-helper.ts';
import { prepareCatalogWebVariants } from './catalog-web-prepare.ts';
import { MediaReadError, type MediaStorageAdapter, objectStoragePath } from './index.ts';
import { createCatalogWebImage } from './web-image.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const objects = new Map<string, Buffer>();
  const events: string[] = [];
  const storage: Pick<MediaStorageAdapter, 'putObject' | 'getObjectAsBase64'> = {
    async putObject(input, options = {}) {
      const storagePath = objectStoragePath(input);
      const target = {
        storageProvider: 'local-disk' as const,
        storageMode: 'local-disk' as const,
        storagePath,
        storageFileId: `local-disk:${storagePath}`,
      };
      await options.beforeWrite?.(target);
      assert.ok(input.content instanceof Uint8Array);
      events.push(`put:${storagePath}`);
      objects.set(target.storageFileId, Buffer.from(input.content));
      return target;
    },
    async getObjectAsBase64(id) {
      events.push(`get:${id}`);
      const bytes = objects.get(id);
      if (!bytes) throw new MediaReadError('unavailable');
      return { body: bytes.toString('base64') };
    },
  };
  return { objects, events, storage };
}

test('real responsive outputs have their declared pixels and only fixed sizes are accepted', async () => {
  const bytes = await largeCatalogPng();
  for (const width of [160, 640, 1280] as const) {
    const result = await createCatalogWebImage(bytes, 'image/png', width);
    const pixels = await sharp(result.bytes).metadata();
    assert.equal(pixels.width, width);
    assert.equal(pixels.height, (width * 1000) / 1600);
    assert.equal(result.width, pixels.width);
  }
  await assert.rejects(createCatalogWebImage(bytes, 'image/png', 320), /width/i);
});

test('every responsive PUT is durably registered, read back, and reused after retry', async () => {
  const bytes = await largeCatalogPng();
  const original = sha(bytes);
  const f = fixture();
  const saved: unknown[] = [];
  const input = {
    imageId: 'responsive',
    bytes,
    mimeType: 'image/png',
    checksumSha256: original,
    storage: f.storage,
    checkpoint: async (value: unknown) => {
      saved.push(structuredClone(value));
      f.events.push('checkpoint');
    },
  };
  const result = await prepareCatalogWebVariants(input);
  assert.ok(result);
  assert.equal(result.default.width, 1280);
  assert.equal(result.variants['160']?.width, 160);
  assert.equal(result.variants['640']?.width, 640);
  assert.equal(saved.length, 3);
  assert.equal(f.objects.size, 3);
  assert.equal(sha(bytes), original);
  for (const [index, event] of f.events.entries())
    if (event.startsWith('put:')) assert.equal(f.events[index - 1], 'checkpoint');
  f.events.length = 0;
  assert.deepEqual(await prepareCatalogWebVariants({ ...input, existing: result }), result);
  assert.equal(f.events.filter((event) => event.startsWith('get:')).length, 3);
  assert.equal(f.events.filter((event) => event.startsWith('put:')).length, 0);
});

test('an interrupted second upload resumes the same three targets with no orphan file', async () => {
  const bytes = await largeCatalogPng();
  const f = fixture();
  let planned: Parameters<typeof prepareCatalogWebVariants>[0]['existing'];
  let fail = true;
  const originalPut = f.storage.putObject;
  f.storage.putObject = async (object, options) =>
    originalPut(object, {
      ...options,
      beforeWrite: async (target) => {
        await options?.beforeWrite?.(target);
        if (fail && f.objects.size === 1) throw Error('unknown second PUT');
      },
    });
  const input = {
    imageId: 'resume',
    bytes,
    mimeType: 'image/png',
    checksumSha256: sha(bytes),
    storage: f.storage,
    checkpoint: async (value: NonNullable<typeof planned>) => {
      planned = structuredClone(value);
    },
  };
  await assert.rejects(prepareCatalogWebVariants(input), /unknown second PUT/);
  assert.ok(planned?.variants['160']);
  assert.equal(f.objects.size, 1);
  fail = false;
  const ready = await prepareCatalogWebVariants({ ...input, existing: planned });
  assert.ok(ready?.variants['640']);
  assert.equal(f.objects.size, 3);
});

test('small originals are never enlarged or copied into duplicate storage objects; animations stay intact', async () => {
  const bytes = await sharp({
    create: { width: 80, height: 600, channels: 3, background: '#234567' },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const f = fixture();
  const input = {
    imageId: 'small',
    bytes,
    mimeType: 'image/png',
    checksumSha256: sha(bytes),
    storage: f.storage,
    checkpoint: async () => {},
  };
  const result = await prepareCatalogWebVariants(input);
  assert.ok(result);
  assert.equal(result.default.width, 80);
  assert.deepEqual(result.variants, {});
  assert.equal(f.objects.size, 1);
  const tiny = await sharp({
    create: { width: 80, height: 50, channels: 3, background: '#234567' },
  })
    .png()
    .toBuffer();
  assert.equal(
    await prepareCatalogWebVariants({
      ...input,
      imageId: 'tiny',
      bytes: tiny,
      checksumSha256: sha(tiny),
    }),
    null,
    'Already-small originals retain their existing delivery',
  );
  const animation = await commentedAnimation(150_000);
  assert.equal(
    await prepareCatalogWebVariants({
      ...input,
      imageId: 'animation',
      bytes: animation,
      mimeType: 'image/gif',
      checksumSha256: sha(animation),
    }),
    null,
  );
  assert.equal(f.objects.size, 1);
});
