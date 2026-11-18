import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import { articleContentHash } from '@vibelingan-channel/articles/drafts';
import type { PublicArticles } from '@vibelingan-channel/articles/public-read';
import { parsePublishedArticle } from '@vibelingan-channel/articles/publication';
import { handlePublicApiEvent } from './http-adapter.ts';
const articles: PublicArticles = {
  list: async () => ({ articles: [], next: null }),
  get: async () => null,
  getRender: async () => null,
  media: async () => null,
};
const call = (path: string, reader: PublicArticles | undefined = articles, method = 'GET') =>
  handlePublicApiEvent({ path, httpMethod: method, headers: {} }, { articles: reader });
test('public article routes are read-only, bounded and explicitly disabled until rollout', async () => {
  const disabled = await handlePublicApiEvent({ path: '/api/articles', httpMethod: 'GET' }, {});
  assert.equal(disabled.statusCode, 404);
  assert.equal((await call('/api/articles', articles, 'POST')).statusCode, 405);
  assert.equal((await call('/api/articles?after=bad.value')).statusCode, 400);
  assert.equal((await call('/api/articles?after=x&after=y')).statusCode, 400);
  const response = await call('/api/articles');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), { ok: true, data: { articles: [], next: null } });
});

test('render-web-v1 is explicit and rejects unknown or duplicate views before reading articles', async () => {
  const calls: string[] = [];
  const reader: PublicArticles = {
    ...articles,
    get: async (slug) => {
      calls.push(`old:${slug}`);
      return null;
    },
    getRender: async (slug) => {
      calls.push(`render:${slug}`);
      return null;
    },
  };
  await call('/api/articles/slug/missing?view=render-web-v1', reader);
  assert.deepEqual(calls, ['render:missing']);
  calls.length = 0;
  for (const query of ['view=unknown', 'view=', 'view=render-web-v1&view=render-web-v1'])
    assert.equal((await call(`/api/articles/slug/missing?${query}`, reader)).statusCode, 400);
  assert.deepEqual(calls, []);
  await call('/api/articles/slug/missing', reader);
  assert.deepEqual(calls, ['old:missing']);
});

test('new render response is separate from unchanged old GET and media filenames pass through unchanged', async () => {
  const content = parseArticleContent({
    title: 'Guide',
    slug: 'guide',
    authorName: 'Diversity',
    excerpt: 'Summary',
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Accepted body' }] }],
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
    media: {},
    publishedAt: '2026-11-16T00:00:00.000Z',
    modifiedAt: '2026-11-16T00:00:00.000Z',
    acceptedAt: '2026-11-16T00:00:01.000Z',
  });
  const render = { schemaVersion: 1 as const, article, presentation: { media: {} } };
  const file = `web-v1-${'a'.repeat(64)}.webp`;
  const reader: PublicArticles = {
    ...articles,
    get: async () => article,
    getRender: async (_slug, onTiming) => {
      onTiming?.({
        slugMs: 12,
        publicationMs: 4,
        publicationReadMs: 3.5,
        publicationValidationMs: 0.4,
        webMediaMs: Number.NaN,
        totalMs: 17,
      });
      return render;
    },
    media: async (id, requested) => {
      assert.equal(id, 'image-one');
      assert.equal(requested, file);
      return { body: 'AQI=', mimeType: 'image/webp' };
    },
  };
  assert.deepEqual(JSON.parse((await call('/api/articles/slug/guide', reader)).body).data, article);
  const response = await call('/api/articles/slug/guide?view=render-web-v1', reader);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).data, render);
  assert.equal(
    response.headers['Server-Timing'],
    'ar-url;dur=12.0, ar-publication;dur=4.0, ar-pub-read;dur=3.5, ar-pub-check;dur=0.4, ar-total;dur=17.0',
  );
  const media = await call(`/api/articles/media/image-one/${file}`, reader);
  assert.equal(media.statusCode, 200);
  assert.equal(media.isBase64Encoded, true);
  assert.equal(media.headers['Cache-Control'], 'no-store');
  assert.equal(media.headers['Content-Type'], 'image/webp');
});

test('an unavailable render read is a no-store 503 and never silently retries the old article mode', async () => {
  let oldReads = 0;
  const response = await call('/api/articles/slug/guide?view=render-web-v1', {
    ...articles,
    get: async () => {
      oldReads++;
      return null;
    },
    getRender: async () => {
      throw Error('cloud://private/image token=secret');
    },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['Retry-After'], '30');
  assert.equal(oldReads, 0);
  assert.doesNotMatch(response.body, /cloud:|token|secret/);
});
test('missing and unavailable content keep distinct HTTP status and never disclose error details', async () => {
  assert.equal((await call('/api/articles/slug/missing')).statusCode, 404);
  assert.equal((await call('/api/articles/media/owned/missing.png')).statusCode, 404);
  assert.equal((await call('/api/articles/extra')).statusCode, 404);
  const failure = await call('/api/articles', {
    ...articles,
    list: async () => {
      throw Error('private connection string');
    },
  });
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.headers['Retry-After'], '30');
  assert(!failure.body.includes('connection string'));
  assert.equal(failure.headers['Cache-Control'], 'no-store');
});

test('health confirms the applied public article flag rather than only the uploaded package', async () => {
  const enabled = await handlePublicApiEvent(
    { path: '/api/health', httpMethod: 'GET' },
    { articles },
  );
  assert.equal(JSON.parse(enabled.body).data.articlePublicReadEnabled, true);
  const disabled = await handlePublicApiEvent({ path: '/api/health', httpMethod: 'GET' }, {});
  assert.equal(JSON.parse(disabled.body).data.articlePublicReadEnabled, false);
});

test('successful image diagnostics expose only fixed finite durations and preserve the binary response', async () => {
  const response = await call('/api/articles/media/image-one/photo.webp', {
    ...articles,
    media: async (_id, _file, options) => {
      assert.equal(options?.measure, true);
      return {
        body: 'AQI=',
        mimeType: 'image/webp',
        timings: {
          referenceBeforeMs: 12.25,
          storageMs: 30,
          lookupMs: 10,
          downloadMs: 19,
          validationMs: 0.5,
          referenceAfterMs: 11,
          totalMs: 54,
          privateUrl: 'https://storage.example/?signature=secret',
          privateTenantId: 42,
        },
      };
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'AQI=');
  assert.equal(response.isBase64Encoded, true);
  assert.equal(response.headers['Content-Type'], 'image/webp');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(
    response.headers['Server-Timing'],
    'am-ref1;dur=12.3, am-storage;dur=30.0, am-url;dur=10.0, am-download;dur=19.0, am-check;dur=0.5, am-ref2;dur=11.0, am-total;dur=54.0',
  );
  assert.doesNotMatch(
    JSON.stringify(response),
    /signature|secret|storage\.example|privateUrl|privateTenantId/,
  );
  assert.equal(response.headers['Timing-Allow-Origin'], undefined);
});

test('invalid diagnostic values and unavailable images cannot disclose timing metadata', async () => {
  const response = await call('/api/articles/media/image-one/photo.webp', {
    ...articles,
    media: async () => ({
      body: 'AQI=',
      mimeType: 'image/webp',
      timings: {
        referenceBeforeMs: Number.NaN,
        storageMs: Number.POSITIVE_INFINITY,
        validationMs: -1,
        referenceAfterMs: 1,
        totalMs: 120001,
      },
    }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Server-Timing'], 'am-ref2;dur=1.0');
  for (const media of [
    async () => null,
    async () => {
      throw Error('private timing information');
    },
  ]) {
    const denied = await call('/api/articles/media/image-one/photo.webp', { ...articles, media });
    assert([404, 503].includes(denied.statusCode));
    assert.equal(denied.headers['Server-Timing'], undefined);
    assert.doesNotMatch(denied.body, /private timing/);
  }
});
