import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  ImageReferenceWriteError,
  assertOrdinaryImageReferenceWrite,
  isImageReferenceWriteConflict,
} from './catalog-image-reference-write.ts';
const image: CollectionDoc = {
  _id: 'image',
  publishedRefCount: 0,
  catalogPublishedReferenceLedger: {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 0,
    pending: [],
  },
};
for (const count of [
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  '1',
  null,
  undefined,
  true,
])
  test(`ordinary counter rejects invalid ${String(count)}`, () => {
    assert.throws(
      () => assertOrdinaryImageReferenceWrite(null, { publishedRefCount: count }),
      ImageReferenceWriteError,
    );
  });
for (const count of [0, 1, Number.MAX_SAFE_INTEGER])
  test(`legacy ordinary counter permits safe value ${count}`, () => {
    assert.doesNotThrow(() =>
      assertOrdinaryImageReferenceWrite(null, { publishedRefCount: count }),
    );
  });
for (const key of [
  'catalogPublishedReferenceLedger',
  'catalogPublishedReferenceLedger.pending',
  'catalogPublishedReferenceLedger[0]',
  'publishedRefCount.value',
  '$set',
])
  test(`ordinary write rejects reserved field path ${key}`, () => {
    assert.throws(
      () => assertOrdinaryImageReferenceWrite(image, { [key]: { publishedRefCount: 1 } }),
      ImageReferenceWriteError,
    );
  });
test('ordinary metadata and equal managed base do not mutate either input', () => {
  const patch = { name: 'photo', publishedRefCount: 0, privateMetadata: { publishedRefCount: 9 } };
  const before = structuredClone([image, patch]);
  assert.doesNotThrow(() => assertOrdinaryImageReferenceWrite(image, patch));
  assert.deepEqual([image, patch], before);
});
test('an absent managed base cannot be initialized through an inherited value', () => {
  const current: CollectionDoc = { _id: 'image', catalogPublishedReferenceLedger: {} };
  Object.setPrototypeOf(current, { publishedRefCount: 0 });
  assert.throws(
    () => assertOrdinaryImageReferenceWrite(current, { publishedRefCount: 0 }),
    ImageReferenceWriteError,
  );
});
test('managed conflict recognition is bounded and works across error serialization', () => {
  let error: unknown;
  try {
    assertOrdinaryImageReferenceWrite(image, { publishedRefCount: 1 });
  } catch (caught) {
    error = caught;
  }
  assert.equal(isImageReferenceWriteConflict(error), true);
  assert.equal(
    isImageReferenceWriteConflict({
      name: 'ImageReferenceWriteError',
      code: 'IMAGE_REFERENCE_WRITE_CONFLICT',
    }),
    true,
  );
  for (const value of [
    null,
    undefined,
    'IMAGE_REFERENCE_WRITE_CONFLICT',
    new Error('secret-url'),
    { name: 'Other', code: 'IMAGE_REFERENCE_WRITE_CONFLICT' },
    { name: 'ImageReferenceWriteError', code: 'INVALID_IMAGE_REFERENCE_WRITE' },
  ])
    assert.equal(isImageReferenceWriteConflict(value), false);
});

for (const field of [
  'status',
  'storageProvider',
  'storageMode',
  'storageFileId',
  'storagePath',
  'mimeType',
  'byteSize',
  'checksumSha256',
  'data',
  'catalogStorageProtection',
  'catalogProtectionIntentId',
])
  test(`ordinary metadata cannot replace managed image content field ${field}`, () => {
    const current = { ...image, [field]: 'original' };
    const before = structuredClone(current);
    assert.throws(
      () => assertOrdinaryImageReferenceWrite(current, { [field]: 'replacement' }),
      ImageReferenceWriteError,
    );
    assert.deepEqual(current, before);
    assert.doesNotThrow(() => assertOrdinaryImageReferenceWrite(current, { [field]: 'original' }));
    assert.doesNotThrow(() => assertOrdinaryImageReferenceWrite(null, { [field]: 'replacement' }));
  });
for (const field of ['storagePath.value', 'catalogStorageProtection.intentId', 'storageFileId[0]'])
  test(`ordinary managed metadata refuses a nested content path ${field}`, () => {
    assert.throws(
      () => assertOrdinaryImageReferenceWrite(image, { [field]: 'replacement' }),
      ImageReferenceWriteError,
    );
  });
test('managed content field presence is preserved while names and the existing mutex remain editable', () => {
  assert.throws(
    () => assertOrdinaryImageReferenceWrite(image, { storagePath: undefined }),
    ImageReferenceWriteError,
  );
  assert.doesNotThrow(() =>
    assertOrdinaryImageReferenceWrite(image, {
      name: 'Renamed',
      imageMutationOwner: 'existing-lock',
      imageMutationStartedAt: '2026-10-18T00:00:00.000Z',
    }),
  );
});
