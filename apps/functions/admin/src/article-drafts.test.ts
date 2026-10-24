import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { handleAdminRequest } from './handler.ts';

const secret = 'article-tests-local-secret';
const content = (title = 'First draft') => ({
  title,
  slug: 'first-draft',
  authorName: 'Local author',
  body: {
    schemaVersion: 1,
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [{ type: 'text', text: 'Private draft body', marks: [] }],
        },
      ],
    },
  },
});

async function setup(t: TestContext, user: Record<string, unknown> | null = { role: 'admin' }) {
  const folder = mkdtempSync(join(tmpdir(), 'channel-article-action-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({ users: user ? [{ _id: 'admin', email: 'admin@example.test', ...user }] : [] }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const token = await signSession(secret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Test admin',
    role: 'admin',
  });
  return { adapter, token, file };
}

test('an authenticated admin gets a clear failure when article storage is not configured', async (t) => {
  const { token } = await setup(t);
  const result = await handleAdminRequest(
    { action: 'articleDrafts', token, data: { operation: 'list', limit: 20 } },
    { jwtSecret: secret },
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Unconfigured storage returned success');
  assert.equal(result.error.code, 'INTERNAL_ERROR');
  assert.match(result.error.message, /article.*storage.*not configured/i);
});

test('article actions use the current role instead of an old admin token', async (t) => {
  for (const role of ['member', 'contributor', 'viewer', '', 'corrupt-role']) {
    const { token } = await setup(t, { role });
    const result = await handleAdminRequest(
      { action: 'articleDrafts', token, data: { operation: 'list', limit: 20 } },
      { jwtSecret: secret },
    );
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('Non-admin article request succeeded');
    assert.equal(result.error.code, 'FORBIDDEN', role);
  }
});

test('article actions reject missing, invalid, deleted, and suspended sessions', async (t) => {
  const { token } = await setup(t, { role: 'admin', status: 'suspended' });
  for (const presented of ['', 'invalid-token', token]) {
    const result = await handleAdminRequest(
      { action: 'articleDrafts', token: presented },
      { jwtSecret: secret },
    );
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('Invalid article session succeeded');
    assert.equal(result.error.code, 'UNAUTHORIZED');
  }
  const removed = await setup(t, null);
  const result = await handleAdminRequest(
    { action: 'articleDrafts', token: removed.token },
    { jwtSecret: secret },
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Deleted account retained article access');
  assert.equal(result.error.code, 'UNAUTHORIZED');
});

test('an admin can create a draft and read it after reopening the local database', async (t) => {
  const { adapter, token, file } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  const created = await handleAdminRequest(
    {
      action: 'articleDrafts',
      token,
      data: { operation: 'create', requestId: 'create-first', content: content() },
    },
    config,
  );
  assert.equal(created.ok, true, 'The local article store must be connected');
  if (!created.ok) throw new Error('Draft creation failed');
  const draft = created.data as {
    id: string;
    revision: number;
    content: { title: string };
    published: unknown;
  };
  assert.equal(draft.revision, 1);
  assert.equal(draft.content.title, 'First draft');
  assert.equal(draft.published, null);
  const reopened = new JsonFileAdapter(file);
  setAdapter(reopened);
  const retrieved = await handleAdminRequest(
    { action: 'articleDrafts', token, data: { operation: 'get', articleId: draft.id } },
    { jwtSecret: secret, articleRepository: reopened.articleRepository },
  );
  assert.equal(retrieved.ok, true);
  if (!retrieved.ok) throw new Error('Persisted draft was lost');
  assert.deepEqual((retrieved.data as { draft: unknown }).draft, draft);
});

test('concurrent create retries and a reopened database return the same draft', async (t) => {
  const { adapter, token, file } = await setup(t);
  const request = {
    action: 'articleDrafts',
    token,
    data: { operation: 'create', requestId: 'retry-create', content: content() },
  };
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  const results = await Promise.all([
    handleAdminRequest(request, config),
    handleAdminRequest(request, config),
  ]);
  for (const result of results) assert.equal(result.ok, true);
  assert.deepEqual(results[0], results[1], 'A retry must not create a second article');
  const reopened = new JsonFileAdapter(file);
  setAdapter(reopened);
  const replayed = await handleAdminRequest(request, {
    jwtSecret: secret,
    articleRepository: reopened.articleRepository,
  });
  assert.deepEqual(replayed, results[0], 'Idempotency must survive a restart');
  const conflict = await handleAdminRequest(
    { ...request, data: { ...request.data, content: content('Different article') } },
    config,
  );
  assert.equal(conflict.ok, false);
  if (conflict.ok) throw new Error('Reusing a request ID replaced the original article');
  assert.equal(conflict.error.code, 'CONFLICT');
});

test('two adapter instances saving one revision have one winner and report the current revision', async (t) => {
  const { adapter, token, file } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  const createRequest = {
    action: 'articleDrafts',
    token,
    data: { operation: 'create', requestId: 'concurrent-save', content: content() },
  };
  const created = await handleAdminRequest(createRequest, config);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('Draft creation failed');
  const draft = created.data as { id: string };
  const second = new JsonFileAdapter(file);
  const save = (title: string) => ({
    action: 'articleDrafts',
    token,
    data: { operation: 'save', articleId: draft.id, expectedRevision: 1, content: content(title) },
  });
  const results = await Promise.all([
    handleAdminRequest(save('Writer one'), config),
    handleAdminRequest(save('Writer two'), {
      jwtSecret: secret,
      articleRepository: second.articleRepository,
    }),
  ]);
  assert.equal(
    results.filter((result) => result.ok).length,
    1,
    'Only one writer may save an old revision',
  );
  const conflict = results.find((result) => !result.ok);
  assert.ok(conflict && !conflict.ok);
  assert.equal(conflict.error.code, 'CONFLICT');
  assert.ok('currentRevision' in conflict.error);
  assert.equal(conflict.error.currentRevision, 2);
  const winner = results.find((result) => result.ok);
  assert.ok(winner?.ok);
  const saved = winner.data as { revision: number; content: ReturnType<typeof content> };
  assert.equal(saved.revision, 2);
  const identical = await handleAdminRequest(
    {
      action: 'articleDrafts',
      token,
      data: { operation: 'save', articleId: draft.id, expectedRevision: 2, content: saved.content },
    },
    config,
  );
  assert.deepEqual(
    identical,
    winner,
    'Saving unchanged content must keep the same revision and timestamps',
  );
  const replay = await handleAdminRequest(createRequest, config);
  assert.deepEqual(replay, winner, 'An old create retry must not restore the first revision');
});

test('draft lists paginate without repeating items and return summaries instead of bodies', async (t) => {
  const { adapter, token } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  const ids = new Set<string>();
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    const result = await handleAdminRequest(
      {
        action: 'articleDrafts',
        token,
        data: { operation: 'create', requestId: `list-${title}`, content: content(title) },
      },
      config,
    );
    assert.ok(result.ok);
    ids.add((result.data as { id: string }).id);
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await handleAdminRequest(
      {
        action: 'articleDrafts',
        token,
        data: { operation: 'list', limit: 1, ...(cursor ? { cursor } : {}) },
      },
      config,
    );
    assert.equal(result.ok, true, 'A configured article store must support listing');
    if (!result.ok) throw new Error('Draft listing failed');
    assert.equal(JSON.stringify(result).includes('Private draft body'), false);
    const page = result.data as {
      items: { id: string; title: string }[];
      nextCursor: string | null;
    };
    assert.equal(page.items.length, 1);
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    assert.ok(seen.length <= 3, 'Cursor must make progress');
  } while (cursor);
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual(new Set(seen), ids);
  const filtered = await handleAdminRequest(
    { action: 'articleDrafts', token, data: { operation: 'list', limit: 20, query: 'ALP' } },
    config,
  );
  assert.ok(filtered.ok);
  const items = (filtered.data as { items: { title: string }[] }).items;
  assert.deepEqual(
    items.map((item) => item.title),
    ['Alpha'],
  );
});

test('preview returns the saved body and media IDs and rejects an outdated revision', async (t) => {
  const { adapter, token } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  const withImage = {
    ...content(),
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [
          {
            type: 'articleImage',
            attrs: { mediaId: 'private-media-1', alt: 'Draft image', caption: '', align: 'center' },
          },
        ],
      },
    },
  };
  const created = await handleAdminRequest(
    {
      action: 'articleDrafts',
      token,
      data: { operation: 'create', requestId: 'preview-create', content: content() },
    },
    config,
  );
  assert.ok(created.ok);
  const draft = created.data as { id: string };
  // Seed an already saved image-bearing draft to test preview independently of media upload.
  await adapter.articleRepository.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: 1,
    content: parseArticleContent(withImage),
  });
  const request = {
    action: 'articleDrafts',
    token,
    data: { operation: 'preview', articleId: draft.id, expectedRevision: 2 },
  };
  const preview = await handleAdminRequest(request, config);
  assert.equal(preview.ok, true, 'A saved draft must have a revision-specific preview');
  if (!preview.ok) throw new Error('Draft preview failed');
  assert.deepEqual(preview.data, {
    articleId: draft.id,
    revision: 2,
    body: withImage.body,
    mediaIds: ['private-media-1'],
  });
  assert.equal(JSON.stringify(preview).includes('https://'), false);
  const saved = await handleAdminRequest(
    {
      action: 'articleDrafts',
      token,
      data: {
        operation: 'save',
        articleId: draft.id,
        expectedRevision: 2,
        content: { ...content(), title: 'Changed title' },
      },
    },
    config,
  );
  assert.ok(saved.ok);
  const stale = await handleAdminRequest(request, config);
  assert.equal(stale.ok, false);
  if (stale.ok) throw new Error('Preview silently used a different revision');
  assert.equal(stale.error.code, 'CONFLICT');
  assert.ok('currentRevision' in stale.error);
  assert.equal(stale.error.currentRevision, 3);
});

test('oversized article requests are rejected before accepting an otherwise valid body', async (t) => {
  const { adapter, token } = await setup(t);
  const large = content();
  const paragraph = large.body.document.content[0];
  assert.ok(paragraph);
  paragraph.content = [
    { type: 'text', text: 'a'.repeat(140000), marks: [] },
    { type: 'text', text: 'b'.repeat(140000), marks: [] },
  ];
  const result = await handleAdminRequest(
    {
      action: 'articleDrafts',
      token,
      data: { operation: 'create', requestId: 'oversized', content: large },
    },
    { jwtSecret: secret, articleRepository: adapter.articleRepository },
  );
  assert.equal(result.ok, false, 'The request limit must be smaller than the content-core limit');
  if (result.ok) throw new Error('Oversized article request was saved');
  assert.equal(result.error.code, 'VALIDATION_ERROR');
  assert.ok(JSON.stringify(result).length < 400, 'Errors must not echo the request body');
});

test('corrupt article records fail safely and are never overwritten by a retry', async (t) => {
  const { adapter, token, file } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  const request = {
    action: 'articleDrafts',
    token,
    data: { operation: 'create', requestId: 'corrupt-create', content: content() },
  };
  const created = await handleAdminRequest(request, config);
  assert.ok(created.ok);
  const draft = created.data as { id: string };
  const store = JSON.parse(readFileSync(file, 'utf8'));
  store.articleDrafts[0].draft.revision = 'broken-private-value';
  const corrupted = JSON.stringify(store);
  writeFileSync(file, corrupted);
  for (const data of [
    { operation: 'get', articleId: draft.id },
    { operation: 'list', limit: 20 },
    {
      operation: 'save',
      articleId: draft.id,
      expectedRevision: 1,
      content: content('Replacement'),
    },
    request.data,
    { ...request.data, requestId: 'new-create' },
  ]) {
    const result = await handleAdminRequest({ action: 'articleDrafts', token, data }, config);
    assert.equal(result.ok, false, JSON.stringify(data.operation));
    if (result.ok) throw new Error('Corrupt storage was silently accepted');
    assert.equal(
      result.error.code,
      'INTERNAL_ERROR',
      'Stored corruption is not a client validation error',
    );
    assert.equal(JSON.stringify(result).includes('broken-private-value'), false);
    assert.equal(
      readFileSync(file, 'utf8'),
      corrupted,
      'A failed read or write must preserve the corrupt file',
    );
  }
});

test('strict article operations reject extra fields, invalid pagination, and missing drafts', async (t) => {
  const { adapter, token } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  for (const data of [
    { operation: 'publish' },
    { operation: 'create', requestId: 'strict', content: content(), collection: 'users' },
    { operation: 'list', limit: 0 },
    { operation: 'list', limit: 51 },
    { operation: 'list', limit: 1.5 },
    { operation: 'list', query: 'x'.repeat(101) },
    { operation: 'list', cursor: 'not-a-cursor' },
    { operation: 'save', articleId: 'missing', expectedRevision: 0, content: content() },
  ]) {
    const result = await handleAdminRequest({ action: 'articleDrafts', token, data }, config);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
  for (const data of [
    { operation: 'get', articleId: 'missing' },
    { operation: 'save', articleId: 'missing', expectedRevision: 1, content: content() },
    { operation: 'preview', articleId: 'missing', expectedRevision: 1 },
  ]) {
    const result = await handleAdminRequest({ action: 'articleDrafts', token, data }, config);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'NOT_FOUND');
  }
});

test('generic CRUD cannot access or change article collections', async (t) => {
  const { token } = await setup(t);
  for (const collection of ['articleDrafts', 'articlePublications', 'articleSlugs']) {
    for (const action of [
      'list',
      'get',
      'create',
      'update',
      'remove',
      'batchUpdate',
      'batchRemove',
    ]) {
      const result = await handleAdminRequest(
        {
          action,
          token,
          data: {
            collection,
            id: 'article-1',
            ids: ['article-1'],
            page: 1,
            pageSize: 1,
            values: {},
          },
        },
        { jwtSecret: secret },
      );
      assert.ok(!result.ok, `${action} must not bypass article access rules`);
      assert.equal(result.error.code, 'UNKNOWN_COLLECTION', `${action}: ${collection}`);
    }
  }
});

test('the local repository checks the account again after handler authorization', async (t) => {
  const { adapter } = await setup(t);
  await adapter.update('users', 'admin', { status: 'suspended' });
  await assert.rejects(
    adapter.articleRepository.create({
      actorId: 'admin',
      requestId: 'revoked',
      content: parseArticleContent(content()),
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'UNAUTHORIZED',
  );
});

test('changing a list query invalidates its cursor and malformed encodings are rejected', async (t) => {
  const { adapter, token } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  for (const name of ['Alpha', 'Another'])
    await handleAdminRequest(
      {
        action: 'articleDrafts',
        token,
        data: { operation: 'create', requestId: name, content: content(name) },
      },
      config,
    );
  const first = await handleAdminRequest(
    { action: 'articleDrafts', token, data: { operation: 'list', limit: 1, query: 'A' } },
    config,
  );
  assert.ok(first.ok);
  const { nextCursor } = first.data as { nextCursor: string };
  for (const data of [
    { operation: 'list', limit: 1, query: 'Beta', cursor: nextCursor },
    { operation: 'list', limit: 1, query: 'A', cursor: `${nextCursor}!!` },
  ]) {
    const result = await handleAdminRequest({ action: 'articleDrafts', token, data }, config);
    assert.ok(!result.ok, 'Invalid cursors must not silently select another page');
    assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
});

test('a Unicode title query can use the next cursor generated for that same query', async (t) => {
  const { adapter, token } = await setup(t);
  const config = { jwtSecret: secret, articleRepository: adapter.articleRepository };
  const query = 'İ'.repeat(100);
  for (const suffix of ['one', 'two']) {
    const created = await handleAdminRequest(
      {
        action: 'articleDrafts',
        token,
        data: { operation: 'create', requestId: suffix, content: content(`${query} ${suffix}`) },
      },
      config,
    );
    assert.ok(created.ok);
  }
  const first = await handleAdminRequest(
    { action: 'articleDrafts', token, data: { operation: 'list', limit: 1, query } },
    config,
  );
  assert.ok(first.ok);
  const { nextCursor } = first.data as { nextCursor: string };
  assert.equal(typeof nextCursor, 'string');
  const second = await handleAdminRequest(
    {
      action: 'articleDrafts',
      token,
      data: { operation: 'list', limit: 1, query, cursor: nextCursor },
    },
    config,
  );
  assert.equal(second.ok, true, 'Case folding must not invalidate a server-generated cursor');
});

test('missing article request data reports invalid input instead of claiming it is oversized', async (t) => {
  const { adapter, token } = await setup(t);
  const result = await handleAdminRequest(
    { action: 'articleDrafts', token },
    { jwtSecret: secret, articleRepository: adapter.articleRepository },
  );
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'VALIDATION_ERROR');
  assert.match(result.error.message, /JSON object/i);
});
