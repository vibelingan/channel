import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArticleDraft } from './draft-repository.ts';
import { createArticleDraft, saveArticleDraft } from './drafts.ts';
import { parsePublishedArticle } from './publication.ts';
import { createArticleReleaseStore } from './release-store.ts';
import type { ArticleStoreTransaction } from './transaction-store.ts';

const start = Date.parse('2026-10-23T01:00:00.000Z');
const content = {
  title: 'Dummy article A',
  slug: 'dummy-article',
  authorName: 'Sean',
  body: {
    schemaVersion: 1,
    document: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dummy body A' }] }],
    },
  },
};
function fixture(mode: 'static' | 'server' = 'static') {
  let now = start;
  let rows = new Map<string, Record<string, unknown>>();
  rows.set('users/admin', { _id: 'admin', role: 'admin', status: 'active' });
  const draft = createArticleDraft({
    id: 'article-a',
    editorId: 'admin',
    now: new Date(now).toISOString(),
    content,
  });
  rows.set('articleDrafts/article-a', {
    _id: draft.id,
    draft,
    requestId: 'create',
    requestActorId: 'admin',
    requestHash: 'a'.repeat(64),
  });
  let tail: Promise<unknown> = Promise.resolve();
  const transaction: ArticleStoreTransaction = (operation) => {
    const run = tail.then(async () => {
      const next = structuredClone(rows);
      let wrote = false;
      const value = await operation({
        read: async (collection, id) => {
          assert(!wrote, 'CloudBase transactions must finish reads before writes');
          return structuredClone(next.get(`${collection}/${id}`) ?? null);
        },
        write: async (collection, id, value) => {
          wrote = true;
          next.set(`${collection}/${id}`, { ...structuredClone(value), _id: id });
        },
      });
      rows = next;
      return value;
    });
    tail = run.catch(() => {});
    return run;
  };
  const service = createArticleReleaseStore(transaction, () => now, { mode });
  const request = {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'publish-a',
  } as const;
  return {
    service,
    request,
    transaction,
    rows: () => rows,
    tick: (ms = 1000) => {
      now += ms;
    },
    draft,
  };
}
test('request freezes a revision, repeated requests deduplicate, and the public view contains no private candidate', async () => {
  const f = fixture();
  const a = await f.service.request('admin', f.request);
  assert.equal(a.state, 'QUEUED');
  assert.deepEqual(await f.service.request('admin', f.request), a);
  assert(!JSON.stringify(a).includes('Dummy body'));
  assert(!('media' in a));
  const saved = saveArticleDraft(f.draft, {
    expectedRevision: 1,
    editorId: 'admin',
    now: new Date(start + 1000).toISOString(),
    content: { ...content, title: 'Draft B' },
  });
  const row = f.rows().get('articleDrafts/article-a');
  assert(row);
  row.draft = saved;
  const claim = await f.service.claim(a.id, 'worker-a');
  assert.equal(claim.candidate?.content.title, 'Dummy article A');
  assert.equal(claim.candidate?.revision, 1);
});
test('concurrent requests serialize; reuse of a request ID for another operation is rejected', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([
    f.service.request('admin', f.request),
    f.service.request('admin', { ...f.request, requestId: 'other' }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(
    f.service.request('admin', { ...f.request, operation: 'withdraw' }),
    /request ID/i,
  );
});
test('non-admin, suspended accounts and stale revisions fail without writes', async () => {
  const f = fixture();
  f.rows().set('users/member', { _id: 'member', role: 'member' });
  await assert.rejects(f.service.request('member', f.request), /Admin/);
  await assert.rejects(f.service.request('missing', f.request), /session/);
  await assert.rejects(
    f.service.request('admin', { ...f.request, expectedRevision: 2 }),
    /changed/,
  );
  assert.equal(f.rows().size, 3);
  const user = f.rows().get('users/admin');
  assert(user);
  user.status = 'suspended';
  await assert.rejects(f.service.request('admin', f.request), /session/);
});
test('only the current worker can complete, preserving a newer draft and its original content', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const claim = await f.service.claim(task.id, 'worker-a');
  await assert.rejects(f.service.claim(task.id, 'worker-b'), /claimed/);
  await f.service.markDeploying(claim.guard);
  const row = f.rows().get('articleDrafts/article-a');
  assert(row);
  row.draft = saveArticleDraft(f.draft, {
    expectedRevision: 1,
    editorId: 'admin',
    now: new Date(start + 1000).toISOString(),
    content: { ...content, title: 'Draft B' },
  });
  f.tick();
  const receipt = {
    deliveryId: 'delivery-a',
    artifactHash: 'b'.repeat(64),
    acceptedAt: new Date(start + 1000).toISOString(),
  };
  const done = await f.service.complete(claim.guard, receipt);
  assert.equal(done.state, 'SUCCEEDED');
  const current = f.rows().get('articleDrafts/article-a')?.draft;
  assert(current && typeof current === 'object');
  assert.equal(savedDraft(current).revision, 2);
  assert.equal(savedDraft(current).content.title, 'Draft B');
  assert.equal(savedDraft(current).published?.revision, 1);
  assert.deepEqual(await f.service.complete(claim.guard, receipt), done);
  await assert.rejects(
    f.service.complete(claim.guard, { ...receipt, deliveryId: 'foreign' }),
    /receipt/,
  );
});

function savedDraft(value: unknown) {
  return parseArticleDraft(value);
}
test('expired BUILDING lease can be reclaimed, but expired DEPLOYING must be reconciled', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const a = await f.service.claim(task.id, 'worker-a');
  f.tick(181000);
  const b = await f.service.claim(task.id, 'worker-b');
  await assert.rejects(f.service.markDeploying(a.guard), /lease/);
  await f.service.markDeploying(b.guard);
  f.tick(181000);
  await assert.rejects(f.service.claim(task.id, 'worker-c'), /check/i);
  assert.equal((await f.service.latest('admin', 'article-a'))?.state, 'UNKNOWN');
  await assert.rejects(
    f.service.request('admin', { ...f.request, requestId: 'newer' }),
    /progress|check/i,
  );
});

test('failed builds neither publish nor restore; a later attempt keeps the frozen revision but uses its own date', async () => {
  const f = fixture();
  const first = await f.service.request('admin', f.request);
  const claim = await f.service.claim(first.id, 'worker-a');
  await f.service.failBuild(claim.guard);
  assert.equal((await f.service.latest('admin', 'article-a'))?.state, 'FAILED');
  assert.equal(savedDraft(f.rows().get('articleDrafts/article-a')?.draft).published, null);
  assert(!f.rows().has('articleAccepted/article-a'));
  f.tick();
  const second = await f.service.request('admin', { ...f.request, requestId: 'retry' });
  const next = await f.service.claim(second.id, 'worker-b');
  assert.equal(next.candidate?.contentHash, claim.candidate?.contentHash);
  assert.equal(next.task.publishedAt, new Date(start + 1000).toISOString());
});

test('update keeps the first publication date, withdrawal keeps draft/media/history and permanently reserves the URL', async () => {
  const f = fixture();
  async function deliver(taskId: string) {
    const claimed = await f.service.claim(taskId, `worker-${taskId}`.slice(0, 128));
    await f.service.markDeploying(claimed.guard);
    f.tick();
    await f.service.complete(claimed.guard, {
      deliveryId: `delivery-${claimed.task.sequence}`,
      artifactHash: 'b'.repeat(64),
      acceptedAt: new Date(start + claimed.task.sequence * 1000).toISOString(),
    });
    return claimed;
  }
  const a = await f.service.request('admin', f.request);
  await deliver(a.id);
  const row = f.rows().get('articleDrafts/article-a');
  assert(row);
  const aDraft = savedDraft(row.draft);
  row.draft = saveArticleDraft(aDraft, {
    expectedRevision: 1,
    editorId: 'admin',
    now: new Date(start + 1000).toISOString(),
    content: { ...content, title: 'Updated article B' },
  });
  const b = await f.service.request('admin', {
    ...f.request,
    expectedRevision: 2,
    requestId: 'publish-b',
  });
  const bClaim = await deliver(b.id);
  assert.equal(bClaim.task.publishedAt, new Date(start).toISOString());
  assert.equal(bClaim.task.modifiedAt, new Date(start + 1000).toISOString());
  const withdraw = await f.service.request('admin', {
    ...f.request,
    operation: 'withdraw',
    expectedRevision: 2,
    requestId: 'withdraw',
  });
  await deliver(withdraw.id);
  assert.equal(savedDraft(f.rows().get('articleDrafts/article-a')?.draft).published, null);
  assert.equal(f.rows().get('articleAccepted/article-a')?.publication, null);
  assert(f.rows().has('articlePublications/article-a:1'));
  assert(f.rows().has('articlePublications/article-a:2'));
  assert.equal(f.rows().get('articleSlugs/dummy-article')?.articleId, 'article-a');
  const current = f.rows().get('articleDrafts/article-a');
  assert(current);
  const draft = savedDraft(current.draft);
  current.draft = saveArticleDraft(draft, {
    expectedRevision: 2,
    editorId: 'admin',
    now: new Date(start + 3000).toISOString(),
    content: { ...content, slug: 'another-url' },
  });
  await assert.rejects(
    f.service.request('admin', { ...f.request, expectedRevision: 3, requestId: 'renamed' }),
    /redirect/,
  );
});

test('possibly deployed work cannot be marked as a build failure and UNKNOWN keeps the article occupied', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const claim = await f.service.claim(task.id, 'worker-a');
  await f.service.markDeploying(claim.guard);
  await assert.rejects(f.service.failBuild(claim.guard), /possibly deployed/);
  await f.service.markUnknown(claim.guard);
  assert.equal((await f.service.latest('admin', 'article-a'))?.state, 'UNKNOWN');
  await assert.rejects(
    f.service.request('admin', { ...f.request, requestId: 'unsafe-retry' }),
    /check/,
  );
  await assert.rejects(
    f.service.complete(claim.guard, {
      deliveryId: 'late',
      artifactHash: 'b'.repeat(64),
      acceptedAt: new Date(start).toISOString(),
    }),
    /confirmed/,
  );
});

test('identity and slug corruption never gets silently replaced', async () => {
  const f = fixture();
  f.rows().set('articleSlugs/dummy-article', {
    _id: 'dummy-article',
    articleId: 'another-article',
  });
  await assert.rejects(f.service.request('admin', f.request), /belongs/);
  assert.equal(f.rows().size, 3);
  f.rows().set('articleSlugs/dummy-article', { _id: 'foreign', articleId: 'article-a' });
  await assert.rejects(f.service.request('admin', f.request), /identity/);
  assert.equal(f.rows().size, 3);
});

test('a revoked requester cannot start cloud delivery with an earlier task', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const claim = await f.service.claim(task.id, 'worker-a');
  f.rows().set('users/admin', { _id: 'admin', role: 'viewer' });
  await assert.rejects(f.service.markDeploying(claim.guard), /Admin/);
  assert.equal(f.rows().get(`articleReleaseTasks/${task.id}`)?.state, 'BUILDING');
});

test('reusing a worker name does not allow a previous lease to write after a new claim', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const old = await f.service.claim(task.id, 'same-worker');
  f.tick(181000);
  const current = await f.service.claim(task.id, 'same-worker');
  assert.equal(current.guard.attempt, old.guard.attempt + 1);
  await assert.rejects(f.service.markDeploying(old.guard), /lease/);
  await f.service.markDeploying(current.guard);
});

test('unchanged content cannot create a new public date or a second task', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const claim = await f.service.claim(task.id, 'worker');
  await f.service.markDeploying(claim.guard);
  const receipt = {
    deliveryId: 'first-delivery',
    artifactHash: 'b'.repeat(64),
    acceptedAt: new Date(start).toISOString(),
  };
  await f.service.complete(claim.guard, receipt);
  const before = structuredClone(f.rows());
  f.tick();
  await assert.rejects(
    f.service.request('admin', { ...f.request, requestId: 'unchanged' }),
    /already published/,
  );
  assert.deepEqual(f.rows(), before);
  await assert.rejects(f.service.latest('missing', 'article-a'), /session/);
});

test('empty content and a missing owned image fail before creating any release records', async () => {
  for (const image of [false, true]) {
    const f = fixture();
    const row = f.rows().get('articleDrafts/article-a');
    assert(row);
    row.draft = createArticleDraft({
      id: 'article-a',
      editorId: 'admin',
      now: new Date(start).toISOString(),
      content: image
        ? {
            ...content,
            body: {
              schemaVersion: 1,
              document: {
                type: 'doc',
                content: [
                  {
                    type: 'articleImage',
                    attrs: {
                      mediaId: 'missing-image',
                      alt: 'Missing image',
                      caption: '',
                      align: 'center',
                    },
                  },
                  { type: 'paragraph', content: [{ type: 'text', text: 'Some text' }] },
                ],
              },
            },
          }
        : { ...content, title: '' },
    });
    await assert.rejects(f.service.request('admin', f.request), { code: 'VALIDATION_ERROR' });
    assert.equal(f.rows().size, 2);
  }
});

test('cancel stops queued work only; retry preserves the frozen revision after further editing', async () => {
  const f = fixture();
  const first = await f.service.request('admin', f.request);
  const cancelled = await f.service.control('admin', {
    operation: 'cancel',
    articleId: f.draft.id,
    taskId: first.id,
    requestId: 'cancel-one',
  });
  assert.equal(cancelled.error, 'CANCELLED');
  const row = f.rows().get('articleDrafts/article-a');
  assert(row);
  f.tick();
  row.draft = saveArticleDraft(f.draft, {
    expectedRevision: 1,
    editorId: 'admin',
    now: new Date(start + 1000).toISOString(),
    content: { ...content, title: 'New unsent draft' },
  });
  const retry = {
    operation: 'retry',
    articleId: f.draft.id,
    taskId: first.id,
    requestId: 'retry-one',
  } as const;
  const next = await f.service.control('admin', retry);
  assert.equal(next.revision, 1);
  assert.notEqual(next.id, first.id);
  assert.deepEqual(await f.service.control('admin', retry), next);
  const claimed = await f.service.claim(next.id, 'worker');
  assert.equal(claimed.candidate?.content.title, content.title);
  await assert.rejects(
    f.service.control('admin', {
      ...retry,
      operation: 'cancel',
      taskId: next.id,
      requestId: 'late-cancel',
    }),
  );
});

test('verified recovery marks failure without moving the accepted publication; unknown cannot be retried', async () => {
  const f = fixture();
  const a = await f.service.request('admin', f.request);
  const claim = await f.service.claim(a.id, 'worker');
  await f.service.markDeploying(claim.guard);
  f.tick();
  await f.service.restored(claim.guard, {
    deliveryId: 'restore-a',
    artifactHash: 'b'.repeat(64),
    acceptedAt: new Date(start + 1000).toISOString(),
  });
  assert.equal((await f.service.latest('admin', f.draft.id))?.error, 'RESTORED');
  assert.equal(savedDraft(f.rows().get('articleDrafts/article-a')?.draft).published, null);
  const next = await f.service.control('admin', {
    operation: 'retry',
    articleId: f.draft.id,
    taskId: a.id,
    requestId: 'retry',
  });
  const second = await f.service.claim(next.id, 'worker');
  await f.service.markDeploying(second.guard);
  await f.service.markUnknown(second.guard);
  await assert.rejects(
    f.service.control('admin', {
      operation: 'retry',
      articleId: f.draft.id,
      taskId: next.id,
      requestId: 'unsafe',
    }),
  );
});

test('a heartbeat after hosting acceptance does not invalidate the real receipt timestamp', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const claim = await f.service.claim(task.id, 'worker');
  await f.service.markDeploying(claim.guard);
  f.tick();
  const receipt = {
    deliveryId: 'accepted',
    artifactHash: 'b'.repeat(64),
    acceptedAt: new Date(start + 1000).toISOString(),
  };
  f.tick();
  await f.service.renew(claim.guard);
  assert.equal((await f.service.complete(claim.guard, receipt)).state, 'SUCCEEDED');
});

test('manual confirmation finishes only an expired uncertain task and preserves the newer draft', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const claim = await f.service.claim(task.id, 'worker-a');
  await f.service.markDeploying(claim.guard);
  f.tick();
  const receipt = {
    deliveryId: 'accepted-run-a',
    artifactHash: 'a'.repeat(64),
    acceptedAt: new Date(start + 1000).toISOString(),
  };
  await f.service.markUnknown(claim.guard);
  await assert.rejects(f.service.confirmAccepted(claim.guard, receipt), /expired uncertain/);
  f.tick(180001);
  await assert.rejects(f.service.complete(claim.guard, receipt), /lease/);
  await assert.rejects(
    f.service.confirmAccepted({ ...claim.guard, attempt: 2 }, receipt),
    /expired uncertain/,
  );
  const row = f.rows().get('articleDrafts/article-a');
  assert(row);
  row.draft = saveArticleDraft(f.draft, {
    expectedRevision: 1,
    editorId: 'admin',
    now: new Date(start + 1001).toISOString(),
    content: { ...content, title: 'Keep next draft' },
  });
  const confirmed = await f.service.confirmAccepted(claim.guard, receipt);
  assert.equal(confirmed.state, 'SUCCEEDED');
  assert.equal(confirmed.error, null);
  const current = parseArticleDraft(f.rows().get('articleDrafts/article-a')?.draft);
  assert.equal(current.content.title, 'Keep next draft');
  assert.equal(current.revision, 2);
  assert.equal(current.published?.revision, 1);
  assert.deepEqual(await f.service.confirmAccepted(claim.guard, receipt), confirmed);
  await assert.rejects(
    f.service.confirmAccepted(claim.guard, { ...receipt, deliveryId: 'different-run' }),
    /receipt/,
  );
});
test('manual confirmation rejects a revoked requester and pre-request receipt', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  const claim = await f.service.claim(task.id, 'worker-a');
  await f.service.markDeploying(claim.guard);
  await f.service.markUnknown(claim.guard);
  f.tick(180001);
  const receipt = {
    deliveryId: 'accepted-run-a',
    artifactHash: 'a'.repeat(64),
    acceptedAt: new Date(start).toISOString(),
  };
  await assert.rejects(
    f.service.confirmAccepted(claim.guard, {
      ...receipt,
      acceptedAt: new Date(start - 1).toISOString(),
    }),
    /expired uncertain/,
  );
  f.rows().set('users/admin', { _id: 'admin', role: 'member', status: 'active' });
  await assert.rejects(f.service.confirmAccepted(claim.guard, receipt), /Admin/);
});

test('server publication commits public content immediately without a build or delivery receipt', async () => {
  const f = fixture('server');
  const results = await Promise.all([
    f.service.request('admin', f.request),
    f.service.request('admin', f.request),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0]?.state, 'SUCCEEDED');
  const accepted = f.rows().get('articleAccepted/article-a');
  assert(accepted?.publication);
  const publication = parsePublishedArticle(accepted.publication);
  assert.equal(publication.content.title, content.title);
  assert.equal(publication.revision, 1);
  const task = f.rows().get(`articleReleaseTasks/${results[0]?.id}`);
  assert.equal(task?.receipt, null);
  assert.equal(task?.workerId, null);
  assert.equal(savedDraft(f.rows().get('articleDrafts/article-a')?.draft).published?.revision, 1);
  const completed = results[0];
  assert(completed);
  await assert.rejects(f.service.claim(completed.id, 'legacy-worker'), /claim|state|complete/i);
});

test('server mode isolates draft edits, updates published content and withdraws atomically', async () => {
  const f = fixture('server');
  await f.service.request('admin', f.request);
  f.tick();
  const row = f.rows().get('articleDrafts/article-a');
  assert(row);
  row.draft = saveArticleDraft(savedDraft(row.draft), {
    expectedRevision: 1,
    editorId: 'admin',
    now: new Date(start + 1000).toISOString(),
    content: { ...content, title: 'Updated public title' },
  });
  assert.equal(
    parsePublishedArticle(f.rows().get('articleAccepted/article-a')?.publication).content.title,
    content.title,
  );
  await f.service.request('admin', { ...f.request, expectedRevision: 2, requestId: 'publish-b' });
  const updated = parsePublishedArticle(f.rows().get('articleAccepted/article-a')?.publication);
  assert.equal(updated.content.title, 'Updated public title');
  assert.equal(updated.publishedAt, new Date(start).toISOString());
  assert.equal(updated.modifiedAt, new Date(start + 1000).toISOString());
  f.tick();
  await f.service.request('admin', {
    ...f.request,
    operation: 'withdraw',
    expectedRevision: 2,
    requestId: 'withdraw-b',
  });
  assert.equal(f.rows().get('articleAccepted/article-a')?.publication, null);
  assert.equal(savedDraft(f.rows().get('articleDrafts/article-a')?.draft).published, null);
  assert(f.rows().has('articlePublications/article-a:1'));
  assert(f.rows().has('articleSlugs/dummy-article'));
});

test('switching modes cannot bypass an in-flight static publication', async () => {
  const f = fixture();
  await f.service.request('admin', f.request);
  const server = createArticleReleaseStore(f.transaction, () => start, { mode: 'server' });
  const before = structuredClone(f.rows());
  await assert.rejects(
    server.request('admin', { ...f.request, requestId: 'server-attempt' }),
    /progress|check/i,
  );
  assert.deepEqual(f.rows(), before);
});

test('server publication storage failure leaves neither a public version nor a success record', async () => {
  const f = fixture();
  const server = createArticleReleaseStore(
    (operation) =>
      f.transaction((store) =>
        operation({
          read: store.read,
          write: async (collection, id, value) => {
            await store.write(collection, id, value);
            if (collection === 'articleAccepted') throw Error('storage unavailable');
          },
        }),
      ),
    () => start,
    { mode: 'server' },
  );
  const before = structuredClone(f.rows());
  await assert.rejects(server.request('admin', f.request), /storage unavailable/);
  assert.deepEqual(f.rows(), before);
});

test('server mode cannot requeue a legacy build retry', async () => {
  const f = fixture();
  const task = await f.service.request('admin', f.request);
  await f.service.control('admin', {
    operation: 'cancel',
    articleId: f.draft.id,
    taskId: task.id,
    requestId: 'cancel',
  });
  const server = createArticleReleaseStore(f.transaction, () => start, { mode: 'server' });
  await assert.rejects(
    server.control('admin', {
      operation: 'retry',
      articleId: f.draft.id,
      taskId: task.id,
      requestId: 'retry',
    }),
    /saved draft/,
  );
  assert.equal(
    (await server.request('admin', { ...f.request, requestId: 'publish-server' })).state,
    'SUCCEEDED',
  );
});
