import assert from 'node:assert/strict';
import test from 'node:test';
import { readAcceptedArticles } from './article-release-source.ts';
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
