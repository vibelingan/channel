import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicArticles } from '@vibelingan-channel/articles/public-read';
import { handlePublicApiEvent } from './http-adapter.ts';
const articles: PublicArticles = {
  list: async () => ({ articles: [], next: null }),
  get: async () => null,
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
