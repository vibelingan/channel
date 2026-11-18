import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import { runCatalogWebBackfill } from './catalog-web-backfill.ts';
import { bindCatalogWebImage, catalogWebImagePath } from './catalog-web-image.ts';
import { imageDeletionStorageTargets } from './image-deletion.ts';

const original: CollectionDoc = {
  _id: 'existing-photo',
  status: 'active',
  storageProvider: 'local-disk',
  storageFileId: 'local-disk:original.png',
  storagePath: 'original.png',
  mimeType: 'image/png',
  byteSize: 500000,
  checksumSha256: 'a'.repeat(64),
  name: 'Human name',
  alt: 'Human description',
  imageMutationOwner: 'operator',
  imageMutationStartedAt: '2026-11-18T01:00:00.000Z',
};
function web(width: number, letter: string) {
  const checksumSha256 = letter.repeat(64);
  const storagePath = catalogWebImagePath(
    original._id,
    String(original.checksumSha256),
    checksumSha256,
  );
  return bindCatalogWebImage(original, {
    storageProvider: 'local-disk',
    storagePath,
    storageFileId: `local-disk:${storagePath}`,
    mimeType: 'image/webp',
    byteSize: width,
    width,
    height: width / 2,
    checksumSha256,
  });
}
const base = web(800, 'b');
const variants = { '160': web(160, 'c'), '640': web(640, 'd') };
function fixture(hasDefault = true) {
  let row: CollectionDoc = {
    ...structuredClone(original),
    ...(hasDefault ? { catalogWebImage: base } : {}),
  };
  const store = {
    get: async () => structuredClone(row),
    set: async (_collection: string, value: CollectionDoc) => {
      row = structuredClone(value);
    },
  };
  const input = {
    imageId: original._id,
    owner: 'operator',
    sourceDigest: storedCatalogImageInputDigest(row),
    catalogWebImage: base,
    catalogWebVariants: variants,
  };
  return {
    store,
    input,
    row: () => row,
    patch: (fields: Record<string, unknown>) => {
      row = { ...row, ...fields };
    },
  };
}

test('existing image preparation is private until commit, keeps manual edits and is replay safe', async () => {
  const f = fixture();
  assert.equal(
    await runCatalogWebBackfill(f.store, {
      ...f.input,
      action: 'checkpoint',
      catalogWebVariants: { '160': variants['160'] },
    }),
    'checkpointed',
  );
  assert.equal(f.row().catalogWebVariants, undefined);
  assert.equal(imageDeletionStorageTargets(f.row())?.storageFileIds.length, 3);
  f.patch({ name: 'Edited during preparation', alt: 'Keep this edit' });
  assert.equal(
    await runCatalogWebBackfill(f.store, { ...f.input, action: 'checkpoint' }),
    'checkpointed',
  );
  assert.equal(await runCatalogWebBackfill(f.store, { ...f.input, action: 'complete' }), 'ready');
  assert.equal(f.row().name, 'Edited during preparation');
  assert.equal(f.row().alt, 'Keep this edit');
  assert.equal(f.row().storageFileId, original.storageFileId);
  assert.deepEqual(f.row().catalogWebImage, base);
  assert.deepEqual(f.row().catalogWebVariants, variants);
  assert.equal(Object.hasOwn(f.row(), 'imageWebPreparation'), false);
  assert.equal(await runCatalogWebBackfill(f.store, { ...f.input, action: 'complete' }), 'ready');
});

test('a missing checkpoint, incomplete set, changed target or dropped target cannot commit', async () => {
  const f = fixture();
  assert.equal(
    await runCatalogWebBackfill(f.store, { ...f.input, action: 'complete' }),
    'conflict',
  );
  const one = { ...f.input, catalogWebVariants: { '160': variants['160'] } };
  assert.equal(
    await runCatalogWebBackfill(f.store, { ...one, action: 'checkpoint' }),
    'checkpointed',
  );
  assert.equal(await runCatalogWebBackfill(f.store, { ...one, action: 'complete' }), 'conflict');
  assert.equal(
    await runCatalogWebBackfill(f.store, {
      ...f.input,
      action: 'checkpoint',
      catalogWebVariants: {},
    }),
    'conflict',
  );
  assert.equal(
    await runCatalogWebBackfill(f.store, {
      ...f.input,
      action: 'checkpoint',
      catalogWebVariants: { ...variants, '160': web(160, 'e') },
    }),
    'conflict',
  );
});

test('source changes, lost lock, quarantine and foreign preparation stop an existing-image write', async () => {
  for (const patch of [
    { checksumSha256: 'f'.repeat(64) },
    { imageMutationOwner: 'someone-else' },
    { status: 'deleting' },
    { imageWebPreparation: { schemaVersion: 'unknown' } },
    { catalogWebImage: web(800, 'e') },
  ]) {
    const f = fixture();
    f.patch(patch);
    const before = structuredClone(f.row());
    assert.equal(
      await runCatalogWebBackfill(f.store, { ...f.input, action: 'checkpoint' }),
      'conflict',
    );
    assert.deepEqual(f.row(), before);
  }
});

test('reviewed originals begin serving new files only after the full prepared set is committed', async () => {
  const f = fixture(false);
  const input = { ...f.input, allowNewDefault: true as const };
  assert.equal(
    await runCatalogWebBackfill(f.store, { ...f.input, action: 'checkpoint' }),
    'conflict',
  );
  assert.equal(await runCatalogWebBackfill(f.store, { ...input, action: 'complete' }), 'conflict');
  assert.equal(
    await runCatalogWebBackfill(f.store, {
      ...input,
      action: 'checkpoint',
      catalogWebVariants: {},
    }),
    'checkpointed',
  );
  assert.equal(f.row().catalogWebImage, undefined);
  assert.deepEqual(imageDeletionStorageTargets(f.row())?.storageFileIds, [
    original.storageFileId,
    base.storageFileId,
  ]);
  assert.equal(
    await runCatalogWebBackfill(f.store, {
      ...input,
      action: 'checkpoint',
      catalogWebImage: web(800, 'e'),
    }),
    'conflict',
  );
  assert.equal(
    await runCatalogWebBackfill(f.store, { ...input, action: 'checkpoint' }),
    'checkpointed',
  );
  f.patch({ alt: 'A person edited this while the files were prepared' });
  assert.equal(await runCatalogWebBackfill(f.store, { ...input, action: 'complete' }), 'ready');
  assert.deepEqual(f.row().catalogWebImage, base);
  assert.deepEqual(f.row().catalogWebVariants, variants);
  assert.equal(f.row().alt, 'A person edited this while the files were prepared');
  assert.equal(f.row().storageFileId, original.storageFileId);
  assert.equal(await runCatalogWebBackfill(f.store, { ...input, action: 'complete' }), 'ready');
});
