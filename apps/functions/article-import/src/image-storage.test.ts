import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { MediaStorageAdapter } from '@vibelingan-channel/media-storage';
import { createArticleImageStorage } from './image-storage.ts';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=',
  'base64',
);
const file = {
  fileName: 'image.png',
  byteSize: png.length,
  mimeType: 'image/png' as const,
  checksumSha256: createHash('sha256').update(png).digest('hex'),
};
function fixture() {
  let checkpoint = false;
  const calls: string[] = [];
  const adapter: MediaStorageAdapter = {
    async getUploadCredential(path) {
      return {
        method: 'PUT',
        uploadUrl: `https://fixture.cos.ap-shanghai.myqcloud.com/${path}`,
        storageFileId: `cloud://fixture/${path}`,
        headers: {
          Signature: 'sig',
          authorization: 'sig',
          'x-cos-security-token': 'token',
          'x-cos-meta-fileid': 'id',
          key: path,
        },
      };
    },
    async putObject(input, options) {
      const value = {
        storageProvider: 'cloudbase-storage' as const,
        storageMode: 'classic-nosql-storage' as const,
        storageFileId: 'cloud://fixture/sealed',
        storagePath: `${input.namespace}/${input.logicalId}/${input.fileName}`,
      };
      await options?.beforeWrite?.(value);
      assert(checkpoint);
      calls.push('write');
      assert.deepEqual(input.content, png);
      return value;
    },
    async getObjectAsBase64(_id, options) {
      assert.equal(options?.maxBytes, 3 * 1024 * 1024);
      assert.equal(options?.timeoutMs, 15000);
      return { body: png.toString('base64') };
    },
    async getTempUrl() {
      throw Error('Image import must not expose temporary read URLs');
    },
    async deleteObject() {
      throw Error('Image import must not delete objects');
    },
  };
  return {
    storage: createArticleImageStorage(adapter),
    calls,
    mark: () => {
      checkpoint = true;
      calls.push('checkpoint');
    },
  };
}
test('real image parser checks signature, SHA, size and dimensions; download and permanent copy use the shared adapter', async () => {
  const f = fixture();
  assert.deepEqual(f.storage.validate(png, file), { width: 1, height: 1 });
  for (const input of [
    { ...file, mimeType: 'image/jpeg' as const },
    { ...file, checksumSha256: '0'.repeat(64) },
    { ...file, byteSize: file.byteSize + 1 },
  ])
    assert.throws(() => f.storage.validate(png, input));
  assert.throws(() => f.storage.validate(Buffer.from('<svg></svg>'), file));
  assert.deepEqual(await f.storage.read('cloud://fixture/pending'), png);
  const grant = await f.storage.mint('articles/pending');
  assert.equal(grant.upload.method, 'PUT');
  assert.equal(grant.upload.headers.Signature, 'sig');
  await f.storage.seal('article-image', '0'.repeat(64), png, async () => {
    f.mark();
  });
  assert.deepEqual(f.calls, ['checkpoint', 'write']);
});
