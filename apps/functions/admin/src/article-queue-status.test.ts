import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { type AdminConfig, handleAdminRequest } from './handler.ts';
import { handleAdminFunctionEvent } from './http-adapter.ts';
const key = 'a'.repeat(64);
const hash = createHash('sha256').update(key).digest('hex');
function config(read = async () => ({ hasQueued: true, hasUnknown: false })): AdminConfig {
  return {
    jwtSecret: 'test-secret',
    enableArticleReleases: true,
    articleQueueStatusKeyHash: hash,
    articleQueueStatus: read,
  };
}
test('queue status requires its dedicated key before any storage read', async () => {
  let calls = 0;
  const c = config(async () => {
    calls++;
    return { hasQueued: true, hasUnknown: false };
  });
  for (const token of [undefined, '', 'x', 'b'.repeat(64), 'eyJ.invalid-session']) {
    const r = await handleAdminRequest(
      { action: 'articleQueueStatus', ...(token === undefined ? {} : { token }) },
      c,
    );
    assert(!r.ok);
    assert.equal(r.error.code, 'UNAUTHORIZED');
  }
  assert.equal(calls, 0);
});
test('queue status returns only booleans, never article content or task identifiers', async () => {
  const c = config(async () => ({
    hasQueued: true,
    hasUnknown: false,
    draft: 'private',
    taskId: 'secret',
  }));
  assert.deepEqual(await handleAdminRequest({ action: 'articleQueueStatus', token: key }, c), {
    ok: true,
    data: { enabled: true, hasQueued: true, hasUnknown: false },
  });
});
test('paused publication avoids queue reads and invalid storage cannot look empty', async () => {
  let calls = 0;
  const c = config(async () => {
    calls++;
    throw Error('storage unavailable');
  });
  const paused = await handleAdminRequest(
    { action: 'articleQueueStatus', token: key },
    { ...c, enableArticleReleases: false },
  );
  assert.deepEqual(paused, {
    ok: true,
    data: { enabled: false, hasQueued: false, hasUnknown: false },
  });
  assert.equal(calls, 0);
  const bad = await handleAdminRequest({ action: 'articleQueueStatus', token: key }, c);
  assert(!bad.ok);
  assert.equal(bad.error.code, 'INTERNAL_ERROR');
});
test('the queue key grants no draft, publication, product or user permissions', async () => {
  for (const action of ['articleDrafts', 'articleReleases', 'updateDoc', 'list', 'me']) {
    const r = await handleAdminRequest(
      { action, token: key, data: { operation: 'publish' } },
      config(),
    );
    assert(!r.ok);
    assert.equal(r.error.code, 'UNAUTHORIZED');
  }
});
test('the actual HTTP endpoint accepts a server query without a browser origin and never caches it', async () => {
  const r = await handleAdminFunctionEvent(
    {
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'articleQueueStatus', token: key }),
    },
    config(),
    handleAdminRequest,
  );
  assert('statusCode' in r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.body.includes(key), false);
});
