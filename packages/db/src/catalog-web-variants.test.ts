import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  bindCatalogWebImage,
  catalogWebImagePath,
  extendsCatalogWebVariants,
  hasCompleteCatalogWebVariants,
  readCatalogWebImage,
  readCatalogWebImageAtWidth,
  readCatalogWebVariants,
  retargetCatalogWebImage,
} from './catalog-web-image.ts';
import { executeImageDeletion } from './image-deletion-runner.ts';
import {
  imageDeletionStorageTargets,
  readImageDeletionIntent,
  runImageDeletion,
} from './image-deletion.ts';

const source: CollectionDoc = {
  _id: 'responsive',
  status: 'active',
  storageProvider: 'local-disk',
  storageFileId: 'local-disk:source.png',
  storagePath: 'source.png',
  mimeType: 'image/png',
  byteSize: 4_800_000,
  checksumSha256: 'a'.repeat(64),
  publishedRefCount: 0,
};
function web(width: number, sha: string) {
  const storagePath = catalogWebImagePath(
    source._id,
    String(source.checksumSha256),
    sha.repeat(64),
  );
  return bindCatalogWebImage(source, {
    storageProvider: 'local-disk',
    storagePath,
    storageFileId: `local-disk:${storagePath}`,
    mimeType: 'image/webp',
    width,
    height: width / 2,
    byteSize: width,
    checksumSha256: sha.repeat(64),
  });
}
const base = web(800, 'b');
const variants = { '160': web(160, 'c'), '640': web(640, 'd') };
const ready = { ...source, catalogWebImage: base, catalogWebVariants: variants };

test('size selection preserves the default and uses real pixels; partial/invalid maps cannot be ready', () => {
  assert.deepEqual(readCatalogWebImage(ready), base);
  assert.equal(readCatalogWebImageAtWidth(ready, 1280)?.width, 800);
  assert.equal(readCatalogWebImageAtWidth(ready, 160)?.width, 160);
  assert.equal(readCatalogWebImageAtWidth(ready, 640)?.width, 640);
  assert.equal(hasCompleteCatalogWebVariants(ready), true);
  assert.equal(
    hasCompleteCatalogWebVariants({ ...ready, catalogWebVariants: { '160': variants['160'] } }),
    false,
  );
  for (const patch of [
    { '320': variants['160'] },
    { ...variants, '160': { ...variants['160'], width: 161 } },
    { ...variants, '640': { ...variants['640'], sourceDigest: 'e'.repeat(64) } },
    { ...variants, '640': { ...variants['640'], height: 350 } },
  ]) {
    assert.equal(readCatalogWebVariants({ ...ready, catalogWebVariants: patch }), null);
    assert.equal(readCatalogWebImageAtWidth({ ...ready, catalogWebVariants: patch }, 160), null);
    assert.deepEqual(readCatalogWebImage({ ...ready, catalogWebVariants: patch }), base);
  }
});

test('append-only preparation cannot replace or drop a previously reserved target', () => {
  assert.equal(extendsCatalogWebVariants({ '160': variants['160'] }, variants), true);
  assert.equal(extendsCatalogWebVariants(variants, { '160': variants['160'] }), false);
  assert.equal(extendsCatalogWebVariants(variants, { ...variants, '160': variants['640'] }), false);
  assert.equal(extendsCatalogWebVariants(null, variants), false);
});

test('deletion includes original and every responsive target and refuses unknown target data', () => {
  assert.deepEqual(imageDeletionStorageTargets(ready)?.storageFileIds, [
    source.storageFileId,
    base.storageFileId,
    variants['160'].storageFileId,
    variants['640'].storageFileId,
  ]);
  assert.equal(
    imageDeletionStorageTargets({ ...ready, catalogWebVariants: { unknown: base } }),
    null,
  );
});

test('a verified original move rebinds every size without changing its bytes or paths', () => {
  const next = {
    ...ready,
    storagePath: 'protected/source.png',
    storageFileId: 'local-disk:protected/source.png',
  };
  const moved = retargetCatalogWebImage(ready, next);
  assert.ok(hasCompleteCatalogWebVariants(moved));
  assert.equal(
    readCatalogWebImageAtWidth(moved, 160)?.storageFileId,
    variants['160'].storageFileId,
  );
  assert.notEqual(
    readCatalogWebImageAtWidth(moved, 160)?.sourceDigest,
    variants['160'].sourceDigest,
  );
  assert.equal(hasCompleteCatalogWebVariants({ ...ready, checksumSha256: 'e'.repeat(64) }), false);
  assert.throws(
    () => retargetCatalogWebImage({ ...source, catalogWebVariants: variants }, next),
    /responsive target/,
  );
});

test('five-target deletion cannot finish after a partial failure and resumes the same versioned intent', async () => {
  const now = '2026-11-18T01:00:00.000Z';
  let row: CollectionDoc | null = {
    ...ready,
    uploadedByUserId: 'u',
    imageMutationOwner: 'op',
    imageMutationStartedAt: now,
    migrationStorageFileId: 'local-disk:migration.png',
  };
  const expected = imageDeletionStorageTargets(row)?.storageFileIds;
  assert.ok(expected && expected.length === 5);
  const store = {
    get: async () => structuredClone(row),
    set: async (_c: string, value: CollectionDoc) => {
      row = structuredClone(value);
    },
    remove: async () => {
      row = null;
    },
  };
  const deleted: string[] = [];
  let fail = true;
  const run = () =>
    executeImageDeletion(
      { manage: (command) => runImageDeletion(store, command), get: async () => row },
      { action: 'begin', imageId: source._id, uploadedByUserId: 'u', owner: 'op', startedAt: now },
      async (id) => {
        deleted.push(id);
        if (fail && id === variants['640'].storageFileId) throw Error('uncertain delete');
      },
    );
  assert.equal(await run(), 'failed');
  assert.ok(row);
  const intent = readImageDeletionIntent(row);
  assert.equal(intent?.schemaVersion, 'image-deletion-web-v2');
  assert.deepEqual(intent?.storageFileIds, expected);
  fail = false;
  assert.equal(await run(), 'deleted');
  assert.equal(row, null);
  assert.deepEqual(deleted, [...expected, ...expected]);
});
