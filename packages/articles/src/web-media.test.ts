import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ActiveArticleMedia } from './media.ts';
import {
  ArticleWebMediaDocumentSchema,
  ArticleWebMediaReadySchema,
  ArticleWebPresentationSchema,
  articleWebMediaObjectInput,
  articleWebMediaPath,
  articleWebMediaSource,
  articleWebMediaSourceDigest,
  assertArticleWebMediaSource,
  buildArticleWebPresentation,
  parseArticleWebPresentation,
} from './web-media.ts';

function original(id = 'image-one'): ActiveArticleMedia {
  const path = `articles/2026/11/${id}/original.png`;
  return {
    id,
    articleId: 'article-one',
    status: 'active',
    purpose: 'article-image',
    fileName: 'Original.png',
    mimeType: 'image/png',
    byteSize: 200_000,
    checksumSha256: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdBy: 'admin',
    createdAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-17T00:00:00.000Z',
    pendingStorage: {
      storageFileId: 'cloud://fixture/articles/pending',
      storagePath: 'articles/pending',
    },
    storage: { storageFileId: `cloud://fixture/${path}`, storagePath: path },
    width: 2000,
    height: 1000,
  };
}
function ready(id = 'image-one') {
  const source = articleWebMediaSource(original(id));
  const checksumSha256 = 'c'.repeat(64);
  const input = articleWebMediaObjectInput(source, checksumSha256);
  const path = `articles/2026/11/${input.logicalId}/${input.fileName}`;
  return {
    status: 'ready',
    policyVersion: 'article-web-v1',
    source,
    sourceDigest: articleWebMediaSourceDigest(source),
    web: {
      storageProvider: 'cloudbase-storage',
      storageFileId: `cloud://fixture/${path}`,
      storagePath: path,
      mimeType: 'image/webp',
      byteSize: 30_000,
      width: 1280,
      height: 640,
      checksumSha256,
    },
  };
}
const published = {
  articleId: 'article-one',
  media: {
    'image-one': {
      mimeType: 'image/png' as const,
      byteSize: 200_000,
      width: 2000,
      height: 1000,
      sha256: 'a'.repeat(64),
    },
  },
};

test('source digest binds original bytes and storage but ignores editorial names and timestamps', () => {
  const image = original();
  const source = articleWebMediaSource(image);
  assert.equal(
    articleWebMediaSourceDigest(source),
    createHash('sha256')
      .update(
        JSON.stringify([
          source.mediaId,
          source.articleId,
          source.checksumSha256,
          source.mimeType,
          source.byteSize,
          source.width,
          source.height,
          source.storageFileId,
          source.storagePath,
        ]),
      )
      .digest('hex'),
  );
  assert.deepEqual(
    articleWebMediaSource({ ...image, fileName: 'Renamed.png', createdAt: image.expiresAt }),
    source,
  );
  for (const change of [
    { checksumSha256: 'd'.repeat(64) },
    { width: 1999 },
    { height: 999 },
    { byteSize: 100_000 },
    { articleId: 'article-two' },
    { mediaId: 'image-two' },
    {
      storagePath: 'articles/2026/11/other/original.png',
      storageFileId: 'cloud://fixture/articles/2026/11/other/original.png',
    },
  ])
    assert.notEqual(
      articleWebMediaSourceDigest({ ...source, ...change }),
      articleWebMediaSourceDigest(source),
    );
  assert.throws(() => articleWebMediaSource({ ...image, status: 'pending' }));
});

test('ready records reject unknown fields, invalid source bindings and out-of-budget output', () => {
  const entry = ready();
  assert.deepEqual(ArticleWebMediaReadySchema.parse(entry), entry);
  assert.deepEqual(assertArticleWebMediaSource(entry, original()), entry);
  for (const change of [
    { extra: true },
    { policyVersion: 'article-web-v2' },
    { sourceDigest: 'd'.repeat(64) },
    { source: { ...entry.source, extra: true } },
    { web: { ...entry.web, extra: true } },
    { web: { ...entry.web, byteSize: 3_000_001 } },
    { web: { ...entry.web, width: 1281 } },
    { web: { ...entry.web, height: 16384 } },
    { web: { ...entry.web, width: 1.5 } },
    { web: { ...entry.web, mimeType: 'image/png' } },
    { web: { ...entry.web, storageFileId: 'https://foreign.example/image.webp' } },
    { web: { ...entry.web, storageFileId: `cloud://other/${entry.web.storagePath}` } },
    { web: { ...entry.web, storagePath: 'articles/../secret' } },
  ])
    assert.throws(() => ArticleWebMediaReadySchema.parse({ ...entry, ...change }));
  assert.throws(() =>
    assertArticleWebMediaSource(entry, { ...original(), checksumSha256: 'd'.repeat(64) }),
  );
});

test('sidecar maps are article-owned, bounded and strict at every layer', () => {
  const value = { schemaVersion: 1, articleId: 'article-one', media: { 'image-one': ready() } };
  assert.deepEqual(ArticleWebMediaDocumentSchema.parse(value), value);
  for (const change of [
    { extra: true },
    { schemaVersion: 2 },
    { articleId: 'other' },
    { media: { 'another-id': ready() } },
    {
      media: Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => [`image-${i}`, ready(`image-${i}`)]),
      ),
    },
  ])
    assert.throws(() => ArticleWebMediaDocumentSchema.parse({ ...value, ...change }));
});

test('public presentation only replaces display facts and preserves original publication data', () => {
  const before = structuredClone(published);
  const sidecar = {
    schemaVersion: 1,
    articleId: 'article-one',
    media: { 'image-one': ready(), 'removed-image': ready('removed-image') },
  };
  const entry = ready();
  const value = buildArticleWebPresentation(published, sidecar);
  assert.deepEqual(value, {
    media: {
      'image-one': {
        sourceSha256: 'a'.repeat(64),
        url: articleWebMediaPath('image-one', 'c'.repeat(64)),
        mimeType: 'image/webp',
        width: 1280,
        height: 640,
        byteSize: 30_000,
        sha256: 'c'.repeat(64),
      },
    },
  });
  assert.equal(
    value.media['image-one']?.url,
    `/media/articles/image-one/web-v1-${'c'.repeat(64)}.webp`,
  );
  assert.deepEqual(published, before);
  assert.deepEqual(buildArticleWebPresentation(published, null), { media: {} });
  assert.equal(JSON.stringify(value).includes('cloud://'), false);
  assert.equal(JSON.stringify(value).includes('storagePath'), false);
  for (const change of [
    { mimeType: 'image/jpeg' as const },
    { byteSize: 1 },
    { width: 1 },
    { height: 1 },
    { sha256: 'd'.repeat(64) },
  ])
    assert.throws(() =>
      buildArticleWebPresentation(
        { ...published, media: { 'image-one': { ...published.media['image-one'], ...change } } },
        sidecar,
      ),
    );
  assert.throws(() => buildArticleWebPresentation(published, { ...sidecar, articleId: 'other' }));
  assert.equal(entry.source.checksumSha256, published.media['image-one'].sha256);
});

test('render presentation rejects foreign media, altered URLs, wrong source SHA and leaked private fields', () => {
  const value = buildArticleWebPresentation(published, {
    schemaVersion: 1,
    articleId: 'article-one',
    media: { 'image-one': ready() },
  });
  assert.deepEqual(parseArticleWebPresentation(published, value), value);
  const descriptor = value.media['image-one'];
  assert.ok(descriptor);
  for (const change of [
    { url: 'https://foreign.example/file.webp' },
    { sourceSha256: 'd'.repeat(64) },
    { url: `/media/articles/image-one/${descriptor.sha256}.webp` },
    { url: `/media/articles/image-one/web-v1-${'d'.repeat(64)}.webp` },
    { storageFileId: 'cloud://private/file' },
    { width: 1281 },
  ])
    assert.throws(() =>
      parseArticleWebPresentation(published, {
        media: { 'image-one': { ...descriptor, ...change } },
      }),
    );
  assert.throws(() => parseArticleWebPresentation(published, { media: { foreign: descriptor } }));
  assert.throws(() => parseArticleWebPresentation(published, { ...value, extra: true }));
});

test('local-disk ready files remain provider-bound and same-byte WebP uses a distinct public URL', () => {
  const cloud = original();
  const image = {
    ...cloud,
    mimeType: 'image/webp' as const,
    storage: { ...cloud.storage, storageFileId: `local-disk:${cloud.storage.storagePath}` },
  };
  const source = articleWebMediaSource(image);
  const input = articleWebMediaObjectInput(source, image.checksumSha256);
  const path = `articles/2026/11/${input.logicalId}/${input.fileName}`;
  const entry = {
    ...ready(),
    source,
    sourceDigest: articleWebMediaSourceDigest(source),
    web: {
      ...ready().web,
      storageProvider: 'local-disk',
      storageFileId: `local-disk:${path}`,
      storagePath: path,
      checksumSha256: image.checksumSha256,
    },
  };
  assert.deepEqual(assertArticleWebMediaSource(entry, image), entry);
  assert.notEqual(
    articleWebMediaPath(image.id, image.checksumSha256),
    `/media/articles/${image.id}/${image.checksumSha256}.webp`,
  );
  assert.throws(() =>
    ArticleWebMediaReadySchema.parse({
      ...entry,
      web: { ...entry.web, storageProvider: 'cloudbase-storage' },
    }),
  );
  const presentation = buildArticleWebPresentation(published, {
    schemaVersion: 1,
    articleId: 'article-one',
    media: { 'image-one': ready() },
  });
  const descriptor = presentation.media['image-one'];
  assert.ok(descriptor);
  assert.throws(() =>
    ArticleWebPresentationSchema.parse({
      media: {
        'image-one': {
          ...descriptor,
          url: 'https://foreign.example/file.webp',
        },
      },
    }),
  );
});
