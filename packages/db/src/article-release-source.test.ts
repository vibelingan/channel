import assert from 'node:assert/strict';
import test from 'node:test';
import { readAcceptedArticles, readArticleQueueStatus } from './article-release-source.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
test('accepted export uses actual SDK pagination and rejects malformed public records', async (t) => {
  const f = articleSdkFixture(t);
  for (let i = 0; i < 105; i++)
    f.put('articleAccepted', `article-${String(i).padStart(3, '0')}`, {
      taskId: 'task',
      publication: null,
    });
  assert.deepEqual(await readAcceptedArticles(f.db), []);
  const calls = f.calls.filter((call) => call.api === 'database.getDocument');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.params.collectionName === 'articleAccepted'));
  f.put('articleAccepted', 'bad-record', { taskId: 'task', publication: { status: 'candidate' } });
  await assert.rejects(readAcceptedArticles(f.db));
});

test('queue probe uses real SDK bounded ID projections and treats unfinished work as uncertain', async (t) => {
  const f = articleSdkFixture(t);
  assert.deepEqual(await readArticleQueueStatus(f.db), { hasQueued: false, hasUnknown: false });
  f.put('articleReleaseTasks', 'pending', {
    state: 'QUEUED',
    privateBody: 'must never be returned',
  });
  assert.deepEqual(await readArticleQueueStatus(f.db), { hasQueued: true, hasUnknown: false });
  for (const state of ['BUILDING', 'DEPLOYING', 'UNKNOWN']) {
    f.put('articleReleaseTasks', 'uncertain', { state, privateBody: 'private' });
    assert.deepEqual(await readArticleQueueStatus(f.db), { hasQueued: true, hasUnknown: true });
  }
  const calls = f.calls.filter((c) => c.api === 'database.getDocument');
  assert(calls.length >= 4);
  assert(
    calls.every((c) => c.params.collectionName === 'articleReleaseTasks' && c.params.limit === 1),
  );
  for (const call of calls)
    assert.deepEqual(JSON.parse(String(call.params.projection)), { _id: { $numberInt: '1' } });
});

test('queue SDK read errors never become an empty queue', async (t) => {
  const f = articleSdkFixture(t);
  f.control.returnedReadError = true;
  await assert.rejects(readArticleQueueStatus(f.db));
});
