import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  type CloudBaseStorageSdk,
  createCloudBaseMediaStorage,
  deleteCloudBaseObjects,
} from './cloudbase.ts';

/**
 * Records calls and returns canned responses. Because the adapter is
 * dependency-injected, this fake exercises 100% of cloudbase.ts without a real
 * CloudBase env.
 */
class FakeSdk implements CloudBaseStorageSdk {
  uploads: { cloudPath: string; fileContent: unknown }[] = [];
  tempFileLists: (string | { fileID: string; maxAge?: number })[][] = [];
  deleteFileLists: string[][] = [];

  constructor(private readonly opts: { tempFileURL?: string; downloadContent?: Buffer } = {}) {}

  async uploadFile(o: {
    cloudPath: string;
    fileContent: Buffer | Uint8Array | NodeJS.ReadableStream;
  }) {
    this.uploads.push({ cloudPath: o.cloudPath, fileContent: o.fileContent });
    return { fileID: `cloud://env.bucket/${o.cloudPath}` };
  }
  async getTempFileURL(o: { fileList: (string | { fileID: string; maxAge?: number })[] }) {
    this.tempFileLists.push(o.fileList);
    return {
      fileList: [{ fileID: 'f', tempFileURL: this.opts.tempFileURL ?? 'https://temp/signed' }],
    };
  }
  async downloadFile(_o: { fileID: string }) {
    return { fileContent: this.opts.downloadContent ?? Buffer.from('hello') };
  }
  async deleteFile(o: { fileList: string[] }) {
    this.deleteFileLists.push(o.fileList);
    return { fileList: [] };
  }
}

test('cloudbase putObject (Buffer): server path, fileID, provider/mode, byteSize', async () => {
  const sdk = new FakeSdk();
  const store = createCloudBaseMediaStorage(sdk);
  const bytes = Buffer.from('abc');
  const stored = await store.putObject({
    namespace: 'catalog',
    logicalId: 'img1',
    fileName: 'original-p.jpg',
    mimeType: 'image/jpeg',
    content: bytes,
  });
  // Path is server-generated (date-partitioned) — match shape, not a re-derived literal.
  assert.match(stored.storagePath, /^catalog\/\d{4}\/\d{2}\/img1\/original-p\.jpg$/);
  assert.equal(sdk.uploads[0]?.cloudPath, stored.storagePath);
  assert.equal(stored.storageFileId, `cloud://env.bucket/${stored.storagePath}`);
  assert.equal(stored.storageProvider, 'cloudbase-storage');
  assert.equal(stored.storageMode, 'classic-nosql-storage');
  assert.equal(stored.byteSize, 3);
});

test('cloudbase putObject (stream): byteSize is omitted', async () => {
  const sdk = new FakeSdk();
  const store = createCloudBaseMediaStorage(sdk);
  const stored = await store.putObject({
    namespace: 'catalog',
    logicalId: 'img2',
    fileName: 'original-s.jpg',
    mimeType: 'image/jpeg',
    content: Readable.from([Buffer.from('streamed')]),
  });
  assert.equal(stored.byteSize, undefined);
  assert.ok(!Object.hasOwn(stored, 'byteSize') || stored.byteSize === undefined);
});

test('cloudbase getTempUrl: union call shape + maxAge + expiresAt; default 3600', async () => {
  const sdk = new FakeSdk({ tempFileURL: 'https://temp/abc' });
  const store = createCloudBaseMediaStorage(sdk);

  const r = await store.getTempUrl('cloud://x', 120);
  assert.deepEqual(sdk.tempFileLists[0], [{ fileID: 'cloud://x', maxAge: 120 }]);
  assert.equal(r.url, 'https://temp/abc');
  assert.ok(r.expiresAt && !Number.isNaN(Date.parse(r.expiresAt)));

  await store.getTempUrl('cloud://y'); // default maxAge
  assert.deepEqual(sdk.tempFileLists[1], [{ fileID: 'cloud://y', maxAge: 3600 }]);
});

test('cloudbase getTempUrl: empty tempFileURL throws a clear error', async () => {
  const sdk = new FakeSdk({ tempFileURL: '' });
  const store = createCloudBaseMediaStorage(sdk);
  await assert.rejects(() => store.getTempUrl('cloud://x'), /no temp URL/);
});

test('cloudbase getObjectAsBase64: returns base64 + byteSize', async () => {
  const sdk = new FakeSdk({ downloadContent: Buffer.from('hello world') });
  const store = createCloudBaseMediaStorage(sdk);
  const r = await store.getObjectAsBase64('cloud://x');
  assert.equal(r.body, Buffer.from('hello world').toString('base64'));
  assert.equal(r.byteSize, 'hello world'.length);
});

test('cloudbase deleteObject: deletes the single fileId', async () => {
  const sdk = new FakeSdk();
  const store = createCloudBaseMediaStorage(sdk);
  await store.deleteObject('cloud://x');
  assert.deepEqual(sdk.deleteFileLists.at(-1), ['cloud://x']);
});

test('deleteCloudBaseObjects chunks under the 50-file server cap', async () => {
  const sdk0 = new FakeSdk();
  await deleteCloudBaseObjects(sdk0, []);
  assert.equal(sdk0.deleteFileLists.length, 0); // nothing to delete → no calls

  const sdk50 = new FakeSdk();
  await deleteCloudBaseObjects(
    sdk50,
    Array.from({ length: 50 }, (_, i) => `f${i}`),
  );
  assert.equal(sdk50.deleteFileLists.length, 1);
  assert.equal(sdk50.deleteFileLists[0]?.length, 50);

  const sdk51 = new FakeSdk();
  await deleteCloudBaseObjects(
    sdk51,
    Array.from({ length: 51 }, (_, i) => `f${i}`),
  );
  assert.equal(sdk51.deleteFileLists.length, 2);
  assert.equal(sdk51.deleteFileLists[0]?.length, 50);
  assert.equal(sdk51.deleteFileLists[1]?.length, 1);
});
