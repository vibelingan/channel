import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArticleDraft, prepareArticlePublication } from './drafts.ts';
import { articleMediaPath, parsePublishedArticle } from './publication.ts';

function publicationFixture() {
  const candidate = prepareArticlePublication(
    createArticleDraft({
      id: 'article-one',
      editorId: 'admin',
      now: '2026-10-20T10:00:00.000Z',
      content: {
        title: 'Manufacturing guide',
        slug: 'manufacturing-guide',
        excerpt: 'A practical guide.',
        authorName: 'Example author',
        body: {
          schemaVersion: 1,
          document: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Visible article body.' }] },
            ],
          },
        },
      },
    }),
    '2026-10-21T10:00:00.000Z',
  );
  return {
    status: 'accepted' as const,
    deliveryId: 'delivery-one',
    articleId: candidate.articleId,
    revision: candidate.revision,
    contentHash: candidate.contentHash,
    content: structuredClone(candidate.content),
    publishedAt: '2026-10-21T10:00:00.000Z',
    modifiedAt: '2026-10-21T10:00:00.000Z',
    acceptedAt: '2026-10-21T10:01:00.000Z',
    media: {},
  };
}

test('accepts the frozen public version and rejects drafts, candidates and extra private fields', () => {
  const value = publicationFixture();
  assert.deepEqual(parsePublishedArticle(value), value);
  for (const change of [
    { status: 'pending' },
    { status: 'withdrawn' },
    { createdBy: 'secret' },
    { storage: 'cloud://secret' },
  ]) {
    assert.throws(() => parsePublishedArticle({ ...value, ...change }));
  }
});

test('rejects changed content, invalid publication fields and dates in the wrong order', () => {
  const value = publicationFixture();
  for (const change of [
    { content: { ...value.content, title: 'Unaccepted edit' } },
    { contentHash: '0'.repeat(64) },
    { revision: 0 },
    { modifiedAt: '2026-10-20T00:00:00.000Z' },
    { acceptedAt: '2026-10-21T09:00:00.000Z' },
    { publishedAt: '2026-02-30T00:00:00.000Z' },
  ])
    assert.throws(() => parsePublishedArticle({ ...value, ...change }));
});

test('requires an exact public media map and derives immutable image paths', () => {
  const value = publicationFixture();
  const candidate = prepareArticlePublication(
    createArticleDraft({
      id: value.articleId,
      editorId: 'admin',
      now: value.publishedAt,
      content: {
        ...value.content,
        body: {
          schemaVersion: 1,
          document: {
            type: 'doc',
            content: [
              {
                type: 'articleImage',
                attrs: {
                  mediaId: 'image-one',
                  alt: 'Production line',
                  caption: '',
                  align: 'center',
                },
              },
            ],
          },
        },
      },
    }),
    value.publishedAt,
  );
  const image = {
    mimeType: 'image/webp',
    sha256: 'a'.repeat(64),
    byteSize: 20,
    width: 120,
    height: 80,
  };
  const article = {
    ...value,
    content: candidate.content,
    contentHash: candidate.contentHash,
    media: { 'image-one': image },
  };
  assert.equal(parsePublishedArticle(article).media['image-one']?.width, 120);
  assert.equal(
    articleMediaPath('image-one', image),
    `/media/articles/image-one/${image.sha256}.webp`,
  );
  for (const media of [
    {},
    { 'image-one': { ...image, url: 'cloud://private' } },
    { 'image-one': { ...image, mimeType: 'image/svg+xml' } },
    { 'image-one': image, unused: image },
  ]) {
    assert.throws(() => parsePublishedArticle({ ...article, media }));
  }
  assert.throws(() => articleMediaPath('../private', image));
});
