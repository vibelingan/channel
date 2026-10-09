/** Admin list thumbnails for drafts whose photos are copied but not published (PT-G follow-up). */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductThumbnail } from './CollectionView.tsx';
import { productThumbnailSource } from './product-thumbnail.ts';

const url = (name: string) => `https://sc04.alicdn.com/kf/${name}.jpg`;
const copiedDraft = (overrides: Partial<CollectionDoc> = {}): CollectionDoc => ({
  _id: 'p',
  published: false,
  alibabaReviewPending: true,
  imageIds: ['img-2', 'img-3'],
  alibabaSourceImageUrls: [url('g1'), url('g2'), url('g3')],
  alibabaAutoPhotos: {
    gallery: {
      sources: [url('g1'), url('g2'), url('g3')],
      imageIds: ['img-2', 'img-3'],
      unusable: [url('g1')],
      missing: [],
    },
  },
  ...overrides,
});

test('a live product shows its photo from the public address', () => {
  assert.deepEqual(productThumbnailSource(copiedDraft({ published: true })), {
    kind: 'public',
    imageId: 'img-2',
  });
});

test('a draft with copied photos shows the Alibaba photo its first photo was copied from', () => {
  // g1 was unavailable, so the first stored photo came from g2.
  assert.deepEqual(productThumbnailSource(copiedDraft()), {
    kind: 'alibaba',
    url: url('g2'),
    imageId: 'img-2',
  });
});

test('a draft whose photos an admin changed, or that kept old photos, uses the admin preview', () => {
  assert.deepEqual(productThumbnailSource(copiedDraft({ imageIds: ['admin-upload', 'img-2'] })), {
    kind: 'admin',
    imageId: 'admin-upload',
  });
  // Every new Alibaba photo unavailable: the stored photos are older ones.
  const kept = copiedDraft({
    imageIds: ['old-1'],
    alibabaAutoPhotos: {
      gallery: { sources: [url('n1')], imageIds: ['old-1'], unusable: [url('n1')], missing: [] },
    },
  });
  assert.deepEqual(productThumbnailSource(kept), { kind: 'admin', imageId: 'old-1' });
  // A manual draft with its own upload.
  assert.deepEqual(productThumbnailSource({ _id: 'm', published: false, imageIds: ['upload-1'] }), {
    kind: 'admin',
    imageId: 'upload-1',
  });
});

test('a draft with no stored photo previews Alibaba; nothing at all shows an empty frame', () => {
  assert.deepEqual(
    productThumbnailSource(copiedDraft({ imageIds: undefined, alibabaAutoPhotos: undefined })),
    { kind: 'alibaba', url: url('g1') },
  );
  assert.equal(productThumbnailSource({ _id: 'x', published: false }), null);
});

test('the list never points an unpublished product at the public image address', () => {
  const draft = renderToStaticMarkup(createElement(ProductThumbnail, { doc: copiedDraft() }));
  assert.doesNotMatch(draft, /\/api\/images\//);
  assert.match(draft, new RegExp(`src="${url('g2').replace(/[.]/g, '\\.')}"`));
  assert.match(draft, />New</);
  const edited = renderToStaticMarkup(
    createElement(ProductThumbnail, { doc: copiedDraft({ imageIds: ['admin-upload'] }) }),
  );
  assert.doesNotMatch(edited, /\/api\/images\//);
  assert.match(edited, /data-thumbnail-loading/, 'loads through the admin preview');
  const live = renderToStaticMarkup(
    createElement(ProductThumbnail, { doc: copiedDraft({ published: true }) }),
  );
  assert.match(live, /\/api\/images\/img-2/);
});

test('one admin preview fetch per image serves the list and the edit form; a failure is retried', async (t) => {
  const { getImagePreview } = await import('./api.ts');
  let calls = 0;
  let fail = true;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (fail) return Response.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } });
    return Response.json({
      ok: true,
      data: { id: 'p1', mimeType: 'image/gif', dataBase64: 'R0lG' },
    });
  });
  await assert.rejects(getImagePreview('preview-cache-1'));
  fail = false;
  const [first, second] = await Promise.all([
    getImagePreview('preview-cache-1'),
    getImagePreview('preview-cache-1'),
  ]);
  assert.equal(first, 'data:image/gif;base64,R0lG');
  assert.equal(second, first);
  assert.equal(await getImagePreview('preview-cache-1'), first);
  assert.equal(calls, 2, 'the failure, then one fetch for every later use');
});

test('a copied draft keeps a way back to our stored photo if Alibaba drops the original', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./CollectionView.tsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /onError=\{source\.imageId \? \(\) => setPrimaryFailed\(true\) : undefined\}/,
  );
  assert.match(source, /primaryFailed && source\s*\?\s*\(source\.imageId \?\? null\)/);
});
