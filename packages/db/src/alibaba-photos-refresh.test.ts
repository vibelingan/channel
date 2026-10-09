/** One product, one unit (PT-G): a draft refreshing its Alibaba photos is hidden until they are in. */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { photosRefresh } from './alibaba-product-identity.ts';

const draft = (overrides: Partial<CollectionDoc> = {}): CollectionDoc => ({
  _id: 'p',
  published: false,
  archived: false,
  alibabaSourceImageUrls: ['https://sc04.alicdn.com/a.jpg'],
  alibabaDescriptionImageUrls: ['https://sc04.alicdn.com/d.jpg'],
  imageIds: ['img-a'],
  alibabaAutoPhotos: {
    gallery: { sources: ['https://sc04.alicdn.com/a.jpg'], imageIds: ['img-a'] },
  },
  ...overrides,
});
const newGallery = { alibabaSourceImageUrls: ['https://sc04.alicdn.com/b.jpg'] };

test('a draft whose sync-filled photos change at Alibaba is hidden until refreshed', () => {
  assert.deepEqual(photosRefresh(draft(), newGallery), { alibabaPhotosPending: true });
  // Never filled yet: also the sync's.
  assert.deepEqual(
    photosRefresh(draft({ imageIds: undefined, alibabaAutoPhotos: undefined }), newGallery),
    { alibabaPhotosPending: true },
  );
  // Description photos count the same way.
  assert.deepEqual(
    photosRefresh(draft(), { alibabaDescriptionImageUrls: ['https://sc04.alicdn.com/e.jpg'] }),
    { alibabaPhotosPending: true },
  );
});

test('nothing hides when the photos did not change, are the admin’s, or the product is live', () => {
  assert.deepEqual(
    photosRefresh(draft(), { alibabaSourceImageUrls: ['https://sc04.alicdn.com/a.jpg'] }),
    {},
  );
  assert.deepEqual(photosRefresh(draft(), { alibabaSourceReview: {} }), {});
  assert.deepEqual(photosRefresh(draft({ imageIds: ['admin-photo'] }), newGallery), {});
  for (const state of [
    { published: true },
    { archived: true },
    { catalogDetailApprovalReceipt: { contentFingerprint: 'x' } },
  ])
    assert.deepEqual(photosRefresh(draft(state), newGallery), {});
});

test('a change the photo job would not act on does not hide the draft', () => {
  const nine = Array.from({ length: 9 }, (_, index) => `https://sc04.alicdn.com/g${index}.jpg`);
  const filled = draft({
    alibabaSourceImageUrls: nine,
    imageIds: undefined,
    alibabaAutoPhotos: undefined,
  });
  // Only past the 9 gallery photos the job copies.
  assert.deepEqual(
    photosRefresh(filled, { alibabaSourceImageUrls: [...nine, 'https://sc04.alicdn.com/g9.jpg'] }),
    {},
  );
  // The same photo, now addressed over HTTPS.
  assert.deepEqual(
    photosRefresh(draft({ alibabaSourceImageUrls: ['http://sc04.alicdn.com/a.jpg'] }), {
      alibabaSourceImageUrls: ['https://sc04.alicdn.com/a.jpg'],
    }),
    {},
  );
});
