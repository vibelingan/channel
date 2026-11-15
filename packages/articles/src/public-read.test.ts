import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArticleContent } from './article.ts';
import { articleContentHash } from './drafts.ts';
import { parseArticleRenderWebV1 } from './public-read.ts';
import { parsePublishedArticle } from './publication.ts';

function fixture() {
  const content = parseArticleContent({
    title: 'Guide',
    slug: 'guide',
    authorName: 'Diversity Technology Limited',
    excerpt: 'Summary',
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [
          {
            type: 'articleImage',
            attrs: { mediaId: 'image-one', alt: 'Human image description', caption: '' },
          },
        ],
      },
    },
  });
  const article = parsePublishedArticle({
    articleId: 'article-one',
    status: 'accepted',
    deliveryId: 'delivery-one',
    revision: 1,
    contentHash: articleContentHash(content),
    content,
    publishedAt: '2026-11-16T00:00:00.000Z',
    modifiedAt: '2026-11-16T00:00:00.000Z',
    acceptedAt: '2026-11-16T00:00:01.000Z',
    media: {
      'image-one': {
        mimeType: 'image/png',
        sha256: 'a'.repeat(64),
        byteSize: 500,
        width: 1000,
        height: 600,
      },
    },
  });
  return {
    schemaVersion: 1,
    article,
    presentation: {
      media: {
        'image-one': {
          sourceSha256: 'a'.repeat(64),
          url: `/media/articles/image-one/web-v1-${'b'.repeat(64)}.webp`,
          mimeType: 'image/webp',
          width: 1000,
          height: 600,
          byteSize: 200,
          sha256: 'b'.repeat(64),
        },
      },
    },
  };
}

test('explicit render envelope preserves the published article and exposes only verified display facts', () => {
  const input = fixture();
  assert.deepEqual(parseArticleRenderWebV1(input), input);
  assert.deepEqual(
    parseArticleRenderWebV1({ ...input, presentation: { media: {} } }).article,
    input.article,
  );
  assert.doesNotMatch(
    JSON.stringify(parseArticleRenderWebV1(input)),
    /storageFileId|storagePath|createdBy/,
  );
});

test('strict render envelopes reject private fields, unrelated media, stale source and alternate URLs', () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => ({ ...value, privateField: 'secret' }),
    (value: ReturnType<typeof fixture>) => ({
      ...value,
      article: { ...value.article, createdBy: 'private-editor' },
    }),
    (value: ReturnType<typeof fixture>) => ({
      ...value,
      presentation: { media: { other: value.presentation.media['image-one'] } },
    }),
    (value: ReturnType<typeof fixture>) => ({
      ...value,
      presentation: {
        media: {
          'image-one': { ...value.presentation.media['image-one'], sourceSha256: 'c'.repeat(64) },
        },
      },
    }),
    (value: ReturnType<typeof fixture>) => ({
      ...value,
      presentation: {
        media: {
          'image-one': {
            ...value.presentation.media['image-one'],
            url: 'https://private-storage.example/file.webp',
          },
        },
      },
    }),
    (value: ReturnType<typeof fixture>) => ({
      ...value,
      presentation: {
        media: {
          'image-one': {
            ...value.presentation.media['image-one'],
            storageFileId: 'cloud://private',
          },
        },
      },
    }),
  ])
    assert.throws(() => parseArticleRenderWebV1(mutate(fixture())));
});
