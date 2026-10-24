import assert from 'node:assert/strict';
import test from 'node:test';
import { readArticleQueueProbe } from './blog/queue-probe.mjs';
const key = 'a'.repeat(64);
const response = (data, cache = 'no-store') => ({
  status: 200,
  headers: new Headers({ 'cache-control': cache }),
  body: Buffer.from(JSON.stringify({ ok: true, data })),
});
test('queue probe pins target, bounds the complete response and discloses booleans only', async () => {
  const result = await readArticleQueueProbe({
    key,
    request: async (method, url, options) => {
      assert.equal(method, 'POST');
      assert.equal(new URL(url).hostname, 'diversity-123-d9grnqfux221323bb.service.tcloudbase.com');
      assert.equal(options.maxBytes, 2048);
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { action: 'articleQueueStatus', token: key });
      return response({
        enabled: true,
        hasQueued: true,
        hasUnknown: false,
        private: 'must not appear',
      });
    },
  });
  assert.deepEqual(result, { enabled: true, hasQueued: true, hasUnknown: false });
});
test('bad key, failed response, shared caching or malformed state never means empty', async () => {
  await assert.rejects(
    readArticleQueueProbe({
      key: 'bad',
      request: async () => {
        throw Error('must not call');
      },
    }),
  );
  for (const value of [
    { ...response({}), status: 401 },
    response({ enabled: true, hasQueued: false, hasUnknown: false }, 'public,max-age=3600'),
    response({ enabled: true, hasQueued: 'yes', hasUnknown: false }),
  ])
    await assert.rejects(readArticleQueueProbe({ key, request: async () => value }));
});

test('live credential verification checks exact 401 denials rather than accepting transport failures', async () => {
  const { verifyArticleQueueProbe } = await import('./blog/queue-probe.mjs');
  const calls = [];
  const request = async (method, url, options) => {
    const data = JSON.parse(options.body);
    calls.push(data);
    return calls.length === 1
      ? response({ enabled: true, hasQueued: true, hasUnknown: false })
      : {
          status: 401,
          body: Buffer.from(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } })),
        };
  };
  const result = await verifyArticleQueueProbe({ key, request });
  assert.equal(result.restrictedCredential, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].token === key, false);
  assert.equal(calls[2].action, 'articleDrafts');
});
