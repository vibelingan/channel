import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import { executeArticleDraftRequest } from '@vibelingan-channel/articles/draft-service';
import { prepareArticlePublication } from '@vibelingan-channel/articles/drafts';
import { createCloudBaseArticleRepository } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';

function content(title = 'Cloud draft') {
  return parseArticleContent({
    title,
    slug: '',
    body: { schemaVersion: 1, document: { type: 'doc', content: [] } },
  });
}

test('real SDK transport creates one durable draft across concurrent retries and repository instances', async (t) => {
  const fixture = articleSdkFixture(t);
  const first = createCloudBaseArticleRepository(fixture.db);
  const second = createCloudBaseArticleRepository(fixture.db);
  const input = { actorId: 'admin', requestId: 'create-retry', content: content() };
  const [one, two] = await Promise.all([first.create(input), second.create(input)]);
  assert.deepEqual(one, two);
  assert.equal(
    [...fixture.rows.keys()].filter((key) => key.startsWith('articleDrafts/')).length,
    1,
  );
  assert.deepEqual(await second.get({ actorId: 'admin', articleId: one.id }), one);
  assert.deepEqual(await createCloudBaseArticleRepository(fixture.db).create(input), one);
  await assert.rejects(first.create({ ...input, content: content('Changed retry') }), {
    code: 'CONFLICT',
  });
});

test('real SDK transactions allow one revision winner and unchanged saves preserve the current revision', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const request = { actorId: 'admin', requestId: 'race', content: content() };
  const initial = await repository.create(request);
  const outcomes = await Promise.allSettled([
    repository.save({
      actorId: 'admin',
      articleId: initial.id,
      expectedRevision: 1,
      content: content('Winner A'),
    }),
    createCloudBaseArticleRepository(fixture.db).save({
      actorId: 'admin',
      articleId: initial.id,
      expectedRevision: 1,
      content: content('Winner B'),
    }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  const loser = outcomes.find((item) => item.status === 'rejected');
  assert.ok(loser && loser.status === 'rejected');
  assert.equal(loser.reason.code, 'CONFLICT');
  assert.equal(loser.reason.currentRevision, 2);
  const saved = await repository.get({ actorId: 'admin', articleId: initial.id });
  assert.ok(saved);
  assert.deepEqual(
    await repository.save({
      actorId: 'admin',
      articleId: initial.id,
      expectedRevision: 2,
      content: saved.content,
    }),
    saved,
  );
  assert.deepEqual(
    await repository.create(request),
    saved,
    'Old create retries return the current draft',
  );
  assert.ok(
    fixture.calls.some(
      (call) =>
        call.api === 'database.modifyDocument' &&
        call.params.merge === false &&
        call.params.transactionId,
    ),
  );
});

test('failed commits roll back staged drafts and expose only a safe error', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  fixture.control.failNextCommit = true;
  const request = { actorId: 'admin', requestId: 'failed-commit', content: content() };
  await assert.rejects(repository.create(request), (error) => {
    assert.ok(error instanceof Error && 'code' in error && error.code === 'INTERNAL_ERROR');
    assert.equal(error.message.includes('PRIVATE_DATABASE_DETAIL'), false);
    return true;
  });
  assert.equal(
    [...fixture.rows.keys()].filter((key) => key.startsWith('articleDrafts/')).length,
    0,
  );
  const saved = await repository.create(request);
  assert.equal(saved.revision, 1);
});

test('every cloud repository entry rechecks current admin access', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const draft = await repository.create({
    actorId: 'admin',
    requestId: 'auth',
    content: content(),
  });
  for (const [actorId, row, code] of [
    ['member', { role: 'member', status: 'active' }, 'FORBIDDEN'],
    ['suspended', { role: 'admin', status: 'suspended' }, 'UNAUTHORIZED'],
    ['deleted', null, 'UNAUTHORIZED'],
  ] as const) {
    if (row) fixture.put('users', actorId, row);
    for (const operation of [
      () => repository.create({ actorId, requestId: 'unauthorized', content: content() }),
      () => repository.get({ actorId, articleId: draft.id }),
      () =>
        repository.save({
          actorId,
          articleId: draft.id,
          expectedRevision: 1,
          content: content('Denied'),
        }),
      () => repository.list({ actorId, query: '', limit: 20 }),
      () => repository.getPublication({ actorId, articleId: draft.id, revision: 1 }),
    ])
      await assert.rejects(operation(), { code });
  }
  assert.equal(
    [...fixture.rows.keys()].filter((key) => key.startsWith('articleDrafts/')).length,
    1,
  );
});

test('transaction retries recheck a revoked account before committing an edit', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const draft = await repository.create({
    actorId: 'admin',
    requestId: 'revoke',
    content: content(),
  });
  fixture.control.beforeCommit = () => {
    fixture.control.beforeCommit = undefined;
    fixture.put('users', 'admin', { role: 'admin', status: 'suspended' });
  };
  await assert.rejects(
    repository.save({
      actorId: 'admin',
      articleId: draft.id,
      expectedRevision: 1,
      content: content('Must not land'),
    }),
    { code: 'UNAUTHORIZED' },
  );
  assert.deepEqual(fixture.rows.get(`articleDrafts/${draft.id}`)?.draft, draft);
});

test('zero write acknowledgements are rejected and do not consume a create request', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  fixture.control.zeroNextWrite = true;
  const request = { actorId: 'admin', requestId: 'zero-write', content: content() };
  await assert.rejects(repository.create(request), { code: 'INTERNAL_ERROR' });
  assert.equal(
    [...fixture.rows.keys()].filter((key) => key.startsWith('articleDrafts/')).length,
    0,
  );
  assert.equal((await repository.create(request)).revision, 1);
});

test('cloud list uses summary projection, stable pagination and literal title search', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  for (const [index, title] of ['Alpha [special]', 'Beta', 'Gamma'].entries()) {
    await repository.create({
      actorId: 'admin',
      requestId: `list-${index}`,
      content: content(title),
    });
  }
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await repository.list({
      actorId: 'admin',
      query: '',
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.items.length, 1);
    const item = page.items[0];
    assert.ok(item && !seen.has(item.id));
    assert.equal('body' in item, false);
    assert.equal('content' in item, false);
    seen.add(item.id);
    cursor = page.nextCursor ?? undefined;
    assert.ok(seen.size <= 3);
  } while (cursor);
  assert.equal(seen.size, 3);
  const filtered = await repository.list({ actorId: 'admin', query: '[SPECIAL]', limit: 20 });
  assert.deepEqual(
    filtered.items.map((item) => item.title),
    ['Alpha [special]'],
  );
  const call = fixture.calls
    .filter(
      (item) =>
        item.api === 'database.getDocument' &&
        item.params.collectionName === 'articleDrafts' &&
        !item.params.transactionId,
    )
    .at(-1);
  assert.ok(call && String(call.params.projection).includes('draft.content.title'));
  assert.deepEqual(JSON.parse(String(call.params.order)), { _id: { $numberInt: '1' } });
  assert.equal(
    String(call.params.projection).includes('body'),
    false,
    'Bodies must not be read by the list query',
  );
  assert.ok(
    String(call.params.query).includes('\\\\[special\\\\]'),
    'Query characters must be escaped as text',
  );
});

test('cloud list cursors bind the query and reject noncanonical or malformed values', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  for (let index = 0; index < 2; index++)
    await repository.create({
      actorId: 'admin',
      requestId: `cursor-${index}`,
      content: content('Same title'),
    });
  const first = await repository.list({ actorId: 'admin', query: 'same', limit: 1 });
  assert.ok(first.nextCursor);
  for (const cursor of [first.nextCursor, `${first.nextCursor}=`, 'not-json']) {
    await assert.rejects(repository.list({ actorId: 'admin', query: 'other', limit: 1, cursor }), {
      code: 'VALIDATION_ERROR',
    });
  }
});

test('the article service accepts a next cursor with long Unicode queries and cloud identities', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const query = '文'.repeat(100);
  for (let index = 0; index < 2; index++)
    await repository.create({
      actorId: 'admin',
      requestId: `long-${index}`,
      content: content(query),
    });
  const first = await repository.list({ actorId: 'admin', query, limit: 1 });
  assert.ok(first.nextCursor && first.nextCursor.length > 512);
  const next = await executeArticleDraftRequest(repository, 'admin', {
    operation: 'list',
    query,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.ok(next && typeof next === 'object' && 'items' in next);
  assert.equal((next.items as unknown[]).length, 1);
});

test('list access is rechecked after querying and a newly demoted admin receives no summary', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  await repository.create({ actorId: 'admin', requestId: 'list-revoke', content: content() });
  fixture.control.afterQuery = () =>
    fixture.put('users', 'admin', { role: 'member', status: 'active' });
  await assert.rejects(repository.list({ actorId: 'admin', query: '', limit: 20 }), {
    code: 'FORBIDDEN',
  });
});

test('cloud saves fully replace nested body arrays and preserve published snapshots', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const initial = content();
  initial.slug = 'cloud-publication';
  initial.authorName = 'Test Author';
  initial.body.document.content = [
    {
      type: 'paragraph',
      attrs: { textAlign: null },
      content: [{ type: 'text', text: 'Kept paragraph', marks: [] }],
    },
    {
      type: 'paragraph',
      attrs: { textAlign: null },
      content: [{ type: 'text', text: 'Removed paragraph', marks: [] }],
    },
  ];
  const draft = await repository.create({
    actorId: 'admin',
    requestId: 'published',
    content: initial,
  });
  const candidate = prepareArticlePublication(draft, draft.createdAt);
  const published = {
    revision: 1,
    slug: initial.slug,
    contentHash: candidate.contentHash,
    publishedAt: draft.createdAt,
    modifiedAt: draft.createdAt,
  };
  const stored = fixture.rows.get(`articleDrafts/${draft.id}`);
  assert.ok(stored);
  fixture.put('articleDrafts', draft.id, { ...stored, draft: { ...draft, published } });
  fixture.put('articlePublications', `${draft.id}:1`, { candidate });
  const edited = structuredClone(initial);
  edited.body.document.content.pop();
  const saved = await repository.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: 1,
    content: edited,
  });
  assert.equal(saved?.content.body.document.content.length, 1);
  assert.deepEqual(saved?.published, published);
  const snapshot = await repository.getPublication({
    actorId: 'admin',
    articleId: draft.id,
    revision: 1,
  });
  assert.deepEqual(snapshot, candidate);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot?.content.body.document.content.length, 2);
  fixture.put('articlePublications', `${draft.id}:1`, {
    candidate: { ...candidate, contentHash: '0'.repeat(64) },
  });
  await assert.rejects(
    repository.getPublication({ actorId: 'admin', articleId: draft.id, revision: 1 }),
    { code: 'INTERNAL_ERROR' },
  );
});

test('malformed stored rows and SDK-returned errors fail safely without changing data', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const request = { actorId: 'admin', requestId: 'corrupt', content: content() };
  const draft = await repository.create(request);
  const stored = fixture.rows.get(`articleDrafts/${draft.id}`);
  assert.ok(stored);
  fixture.put('articleDrafts', draft.id, { ...stored, draft: { ...draft, revision: -1 } });
  const before = structuredClone(fixture.rows);
  await assert.rejects(repository.create(request), { code: 'INTERNAL_ERROR' });
  await assert.rejects(repository.get({ actorId: 'admin', articleId: draft.id }), {
    code: 'INTERNAL_ERROR',
  });
  assert.deepEqual(fixture.rows, before);
  fixture.control.returnedReadError = true;
  await assert.rejects(repository.get({ actorId: 'admin', articleId: draft.id }), (error) => {
    assert.ok(error instanceof Error && 'code' in error && error.code === 'INTERNAL_ERROR');
    assert.equal(error.message.includes('PRIVATE_DATABASE_DETAIL'), false);
    return true;
  });
});

test('cloud writes enforce the record byte budget and missing records remain missing', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const large = content();
  large.body.document.content = [
    {
      type: 'paragraph',
      attrs: { textAlign: null },
      content: [
        { type: 'text', text: 'a'.repeat(198000), marks: [] },
        { type: 'text', text: 'b'.repeat(198000), marks: [] },
      ],
    },
  ];
  await assert.rejects(
    repository.create({ actorId: 'admin', requestId: 'record-budget', content: large }),
    { code: 'VALIDATION_ERROR' },
  );
  assert.equal(await repository.get({ actorId: 'admin', articleId: 'missing' }), null);
  assert.equal(
    await repository.save({
      actorId: 'admin',
      articleId: 'missing',
      expectedRevision: 1,
      content: content(),
    }),
    null,
  );
  assert.equal(
    await repository.getPublication({ actorId: 'admin', articleId: 'missing', revision: 1 }),
    null,
  );
  assert.equal(
    [...fixture.rows.keys()].filter((key) => key.startsWith('articleDrafts/')).length,
    0,
  );
});

test('create identities are actor scoped and preview uses the saved revision', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  fixture.put('users', 'other-admin', { role: 'admin', status: 'active' });
  const one = await repository.create({
    actorId: 'admin',
    requestId: 'scoped',
    content: content(),
  });
  const two = await repository.create({
    actorId: 'other-admin',
    requestId: 'scoped',
    content: content(),
  });
  assert.notEqual(one.id, two.id);
  assert.deepEqual(
    await executeArticleDraftRequest(repository, 'admin', {
      operation: 'preview',
      articleId: one.id,
      expectedRevision: 1,
    }),
    {
      articleId: one.id,
      revision: 1,
      body: one.content.body,
      mediaIds: [],
    },
  );
  await assert.rejects(
    executeArticleDraftRequest(repository, 'admin', {
      operation: 'preview',
      articleId: one.id,
      expectedRevision: 2,
    }),
    { code: 'CONFLICT', currentRevision: 1 },
  );
});

test('oversized stored publication records are internal corruption rather than user input errors', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  fixture.put('articlePublications', 'article-oversized:1', {
    candidate: { junk: 'x'.repeat(384 * 1024) },
  });
  await assert.rejects(
    repository.getPublication({ actorId: 'admin', articleId: 'article-oversized', revision: 1 }),
    { code: 'INTERNAL_ERROR' },
  );
});

test('summary projections reject timestamps that the article core would reject', async (t) => {
  const fixture = articleSdkFixture(t);
  const repository = createCloudBaseArticleRepository(fixture.db);
  const draft = await repository.create({
    actorId: 'admin',
    requestId: 'summary-time',
    content: content(),
  });
  const stored = fixture.rows.get(`articleDrafts/${draft.id}`);
  assert.ok(stored);
  fixture.put('articleDrafts', draft.id, {
    ...stored,
    draft: { ...draft, createdAt: '2026-01-01T00:00:00+00:00' },
  });
  await assert.rejects(repository.list({ actorId: 'admin', query: '', limit: 20 }), {
    code: 'INTERNAL_ERROR',
  });
});
