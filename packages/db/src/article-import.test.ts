import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createArticleImportService } from '@vibelingan-channel/articles/import-store';
import { articleTransaction, createCloudBaseArticleRepository } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
const secret = 'f'.repeat(64);
const credential = `content-helper.${secret}`;
const input = {
  idempotencyKey: 'task-1:article-1',
  externalTaskId: 'task-1',
  title: 'Review this draft',
  slug: '',
  format: 'markdown',
  body: '## Useful information\n\nCheck the facts before publishing.',
};
const now = Date.parse('2020-01-01T00:00:00Z');
function setup(t: Parameters<typeof articleSdkFixture>[0]) {
  const f = articleSdkFixture(t);
  const key = {
    _id: 'content-helper',
    siteId: 'supplychainsai.com',
    integrationId: 'hermes-local',
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    enabled: true,
    expiresAt: '2030-10-27T00:00:00.000Z',
    configRevision: 1,
  };
  f.put('articleIntegrations', key._id, key);
  return { ...f, key, service: createArticleImportService(articleTransaction(f.db), () => now) };
}
test('actual SDK transactions create one private draft for eight concurrent same-source retries', async (t) => {
  const f = setup(t);
  const receipts = await Promise.all(
    Array.from({ length: 8 }, () => f.service.create(credential, input)),
  );
  assert.equal(new Set(receipts.map((r) => r.articleId)).size, 1);
  assert.equal(receipts.filter((r) => !r.replayed).length, 1);
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleDrafts/')).length, 1);
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleImports/')).length, 1);
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleImportLimits/')).length, 2);
  const first = receipts[0];
  assert(first);
  const id = first.articleId;
  const draft = await createCloudBaseArticleRepository(f.db).get({
    actorId: 'admin',
    articleId: id,
  });
  assert(draft);
  assert.equal(draft.published, null);
  assert.equal(draft.createdBy, 'integration:hermes-local');
  assert.equal((await f.service.get(credential, first.operationId)).articleId, id);
});
test('a later human edit is preserved by retries; changed source conflicts without writes', async (t) => {
  const f = setup(t);
  const r = await f.service.create(credential, input);
  const repo = createCloudBaseArticleRepository(f.db);
  const draft = await repo.get({ actorId: 'admin', articleId: r.articleId });
  assert(draft);
  await repo.save({
    actorId: 'admin',
    articleId: r.articleId,
    expectedRevision: 1,
    content: { ...draft.content, title: 'Human revision' },
  });
  const before = structuredClone(f.rows);
  const replay = await f.service.create(credential, input);
  assert.equal(replay.importedRevision, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(f.rows, before);
  await assert.rejects(f.service.create(credential, { ...input, title: 'Changed source' }), {
    code: 'CONFLICT',
  });
  assert.deepEqual(f.rows, before);
  assert.equal((await repo.get({ actorId: 'admin', articleId: r.articleId }))?.revision, 2);
});
test('revocation, expiry and foreign imports do not grant access to drafts', async (t) => {
  const f = setup(t);
  const r = await f.service.create(credential, input);
  const before = structuredClone(f.rows);
  await assert.rejects(f.service.create(`content-helper.${'0'.repeat(64)}`, input), {
    code: 'UNAUTHORIZED',
  });
  f.put('articleIntegrations', 'other', { ...f.key, _id: 'other', integrationId: 'someone-else' });
  await assert.rejects(f.service.get(`other.${secret}`, r.operationId), { code: 'NOT_FOUND' });
  f.put('articleIntegrations', f.key._id, { ...f.key, enabled: false });
  await assert.rejects(f.service.create(credential, input), { code: 'UNAUTHORIZED' });
  f.put('articleIntegrations', f.key._id, { ...f.key, expiresAt: '2019-10-25T00:00:00.000Z' });
  await assert.rejects(f.service.get(credential, r.operationId), { code: 'UNAUTHORIZED' });
  assert.deepEqual(
    f.rows.get(`articleDrafts/${r.articleId}`),
    before.get(`articleDrafts/${r.articleId}`),
  );
});
test('quota counters are atomic, bounded and do not charge idempotent replays', async (t) => {
  const f = setup(t);
  const service = createArticleImportService(articleTransaction(f.db), () => now, {
    minute: 1,
    day: 2,
  });
  const r = await service.create(credential, input);
  const before = structuredClone(f.rows);
  assert.equal((await service.create(credential, input)).operationId, r.operationId);
  await assert.rejects(service.create(credential, { ...input, idempotencyKey: 'other' }), {
    code: 'RATE_LIMITED',
    retryAfterSeconds: 60,
  });
  assert.deepEqual(f.rows, before);
});
test('failed commit or zero write cannot leave a partial import or claim success', async (t) => {
  for (const failure of ['failNextCommit', 'zeroNextWrite'] as const) {
    const f = setup(t);
    const before = structuredClone(f.rows);
    if (failure === 'failNextCommit')
      f.control.beforeCommit = () => {
        if (f.calls.some((c) => c.api === 'database.modifyDocument')) {
          f.control.failNextCommit = true;
          f.control.beforeCommit = undefined;
        }
      };
    else f.control.zeroNextWrite = true;
    await assert.rejects(f.service.create(credential, input), { code: 'UNAVAILABLE' });
    assert.deepEqual(f.rows, before);
  }
});
test('revocation just before commit is rechecked on the real SDK retry', async (t) => {
  const f = setup(t);
  f.control.beforeCommit = () => {
    if (f.calls.some((c) => c.api === 'database.modifyDocument')) {
      f.put('articleIntegrations', f.key._id, { ...f.key, enabled: false, configRevision: 2 });
      f.control.beforeCommit = undefined;
    }
  };
  await assert.rejects(f.service.create(credential, input), { code: 'UNAUTHORIZED' });
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleDrafts/')).length, 0);
});
test('a missing imported draft is not recreated or reported as editable', async (t) => {
  const f = setup(t);
  const r = await f.service.create(credential, input);
  f.rows.delete(`articleDrafts/${r.articleId}`);
  await assert.rejects(f.service.get(credential, r.operationId), { code: 'UNAVAILABLE' });
  await assert.rejects(f.service.create(credential, input), { code: 'UNAVAILABLE' });
  assert(!f.rows.has(`articleDrafts/${r.articleId}`));
});
