import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import {
  catalogWebImagePath,
  readCatalogWebImage,
  registerCatalogWebImage,
} from './catalog-web-image.ts';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const source: CollectionDoc = {
  _id: 'image-1',
  name: 'source.png',
  status: 'active',
  storageProvider: 'cloudbase-storage',
  storageFileId: 'cloud://env.bucket/source.png',
  storagePath: 'source.png',
  mimeType: 'image/png',
  byteSize: 5_000_000,
  checksumSha256: sha('source'),
  publishedRefCount: 1,
};
function delivery() {
  const checksumSha256 = sha('web');
  const storagePath = catalogWebImagePath(
    source._id,
    String(source.checksumSha256),
    checksumSha256,
  );
  return {
    schemaVersion: 1,
    sourceDigest: storedCatalogImageInputDigest(source),
    storageProvider: 'cloudbase-storage',
    storageFileId: `cloud://env.bucket/${storagePath}`,
    storagePath,
    mimeType: 'image/webp',
    byteSize: 1000,
    width: 1280,
    height: 960,
    checksumSha256,
  };
}
test('only an exact source-bound and content-addressed web image is selected', () => {
  const web = delivery();
  assert.deepEqual(readCatalogWebImage({ ...source, catalogWebImage: web }), web);
  for (const field of [
    'checksumSha256',
    'storageFileId',
    'storagePath',
    'mimeType',
    'byteSize',
    'status',
    'storageProvider',
  ])
    assert.equal(
      readCatalogWebImage({
        ...source,
        [field]: field === 'byteSize' ? 5000001 : 'changed',
        catalogWebImage: web,
      }),
      null,
      field,
    );
  assert.deepEqual(
    readCatalogWebImage({ ...source, publishedRefCount: 0, catalogWebImage: web }),
    web,
  );
});
test('invalid paths, dimensions, oversized output and incompatible providers fail closed', () => {
  for (const patch of [
    { storageFileId: 'cloud://other.bucket/arbitrary' },
    { storagePath: '../original.png' },
    { mimeType: 'text/html' },
    { byteSize: 3_000_001 },
    { width: 1281 },
    { height: 0 },
    { storageProvider: 'local-disk' },
    { sourceDigest: sha('another') },
  ])
    assert.equal(
      readCatalogWebImage({ ...source, catalogWebImage: { ...delivery(), ...patch } }),
      null,
    );
});
test('registration rechecks the current source and preserves new refcounts and human fields', async () => {
  let row: CollectionDoc = { ...source, publishedRefCount: 3, customAlt: 'Human caption' };
  let writes = 0;
  const tx = {
    get: async () => row,
    set: async (_c: string, next: CollectionDoc) => {
      row = next;
      writes++;
    },
  };
  assert.equal(await registerCatalogWebImage(tx, source._id, delivery()), 'registered');
  assert.equal(writes, 1);
  assert.equal(row.publishedRefCount, 3);
  assert.equal(row.customAlt, 'Human caption');
  assert.equal(row.storageFileId, source.storageFileId);
  assert.equal(await registerCatalogWebImage(tx, source._id, delivery()), 'unchanged');
  assert.equal(writes, 1);
  row = { ...row, checksumSha256: sha('new source') };
  await assert.rejects(registerCatalogWebImage(tx, source._id, delivery()), /source/i);
  assert.equal(writes, 1);
});
test('failed registration propagates instead of reporting a ready derivative', async () => {
  await assert.rejects(
    registerCatalogWebImage(
      {
        get: async () => source,
        set: async () => {
          throw Error('commit failed');
        },
      },
      source._id,
      delivery(),
    ),
    /commit failed/,
  );
});
