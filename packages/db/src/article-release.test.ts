import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import {
  createCloudBaseArticleReleaseWorker,
  createCloudBaseArticleRepository,
} from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';

const content = parseArticleContent({
  title: 'SDK publication',
  slug: 'sdk-publication',
  authorName: 'Sean',
  body: {
    schemaVersion: 1,
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Real SDK, offline transport only.' }],
        },
      ],
    },
  },
});

test('installed SDK transactions atomically reserve the task, slug and frozen article across concurrent request retries', async (t) => {
  const f = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(f.db);
  const draft = await repository.create({ actorId: 'admin', requestId: 'sdk-create', content });
  const input = {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'sdk-publish',
  } as const;
  const worker = createCloudBaseArticleReleaseWorker(f.db);
  const [one, same] = await Promise.all([
    worker.request('admin', input),
    createCloudBaseArticleReleaseWorker(f.db).request('admin', input),
  ]);
  assert.deepEqual(one, same);
  assert.equal(
    [...f.rows.keys()].filter((key) => key.startsWith('articleReleaseTasks/')).length,
    1,
  );
  assert.equal(
    (await repository.getPublication({ actorId: 'admin', articleId: draft.id, revision: 1 }))
      ?.contentHash.length,
    64,
  );
  const claim = await worker.claim(one.id, 'sdk-worker');
  await worker.markDeploying(claim.guard);
  await repository.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: 1,
    content: { ...content, title: 'Later private draft' },
  });
  await worker.complete(claim.guard, {
    deliveryId: 'sdk-delivery',
    artifactHash: 'a'.repeat(64),
    acceptedAt: new Date().toISOString(),
  });
  const current = await repository.get({ actorId: 'admin', articleId: draft.id });
  assert.equal(current?.revision, 2);
  assert.equal(current?.content.title, 'Later private draft');
  assert.equal(current?.published?.revision, 1);
  const accepted = f.rows.get(`articleAccepted/${draft.id}`)?.publication;
  assert(accepted && typeof accepted === 'object');
  assert.equal(Reflect.get(accepted, 'revision'), 1);
  assert.equal((await repository.releases?.latest('admin', draft.id))?.state, 'SUCCEEDED');
  const calls = f.calls.filter((call) => call.api === 'database.modifyDocument');
  assert(calls.length > 8);
  assert(calls.every((call) => call.params.transactionId && call.params.merge === false));
});

for (const mode of ['commit', 'write-ack', 'read-error'] as const)
  test(`SDK ${mode} failure cannot leave a partial task, slug or candidate`, async (t) => {
    const f = articleSdkFixture(t);
    const repository = createCloudBaseArticleRepository(f.db);
    const draft = await repository.create({ actorId: 'admin', requestId: 'sdk-create', content });
    const before = structuredClone(f.rows);
    if (mode === 'commit') f.control.failNextCommit = true;
    if (mode === 'write-ack') f.control.zeroNextWrite = true;
    if (mode === 'read-error') f.control.returnedReadError = true;
    await assert.rejects(
      createCloudBaseArticleReleaseWorker(f.db).request('admin', {
        operation: 'publish',
        articleId: draft.id,
        expectedRevision: 1,
        requestId: 'fail-request',
      }),
      (error) => {
        assert(error instanceof Error && 'code' in error);
        assert.equal(error.code, 'INTERNAL_ERROR');
        assert(!error.message.includes('PRIVATE_DATABASE_DETAIL'));
        return true;
      },
    );
    assert.deepEqual(f.rows, before);
  });

test('SDK transaction retries recompute slug ownership instead of overwriting the other winner', async (t) => {
  const f = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(f.db);
  const a = await repository.create({ actorId: 'admin', requestId: 'first', content });
  const b = await repository.create({ actorId: 'admin', requestId: 'second', content });
  const worker = createCloudBaseArticleReleaseWorker(f.db);
  const result = await Promise.allSettled(
    [a, b].map((draft) =>
      worker.request('admin', {
        operation: 'publish',
        articleId: draft.id,
        expectedRevision: 1,
        requestId: draft.id,
      }),
    ),
  );
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal([...f.rows.keys()].filter((key) => key.startsWith('articleSlugs/')).length, 1);
  assert.equal(
    [...f.rows.keys()].filter((key) => key.startsWith('articleReleaseTasks/')).length,
    1,
  );
});
