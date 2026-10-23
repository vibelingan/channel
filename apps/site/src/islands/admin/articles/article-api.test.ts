import assert from 'node:assert/strict';
import test from 'node:test';
import { readDraftResponse } from './article-api.ts';

test('article responses reject malformed records and a different article identity', () => {
  const draft = {
    id: 'a',
    revision: 1,
    content: {
      title: '',
      slug: '',
      body: { schemaVersion: 1, document: { type: 'doc', content: [] } },
    },
    createdBy: 'user',
    updatedBy: 'user',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    published: null,
  };
  assert.equal(readDraftResponse(draft, 'a').id, 'a');
  assert.throws(() => readDraftResponse(draft, 'b'), /could not be confirmed/);
  assert.throws(() => readDraftResponse({ ...draft, revision: 0 }), /could not be confirmed/);
  assert.throws(
    () =>
      readDraftResponse({ ...draft, content: { ...draft.content, body: { schemaVersion: 7 } } }),
    /could not be confirmed/,
  );
});

test('article conflict errors retain the server revision for the shared admin request layer', async () => {
  const { AdminApiError, call } = await import('../api.ts');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: false,
      error: { code: 'CONFLICT', message: 'Draft changed', currentRevision: 7 },
    });
  try {
    await assert.rejects(
      call('articleDrafts', { operation: 'save' }),
      (error: unknown) =>
        error instanceof AdminApiError && error.currentRevision === 7 && error.code === 'CONFLICT',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('release responses validate article and requested revision instead of trusting a successful HTTP result', async () => {
  const { readArticleReleaseResponse } = await import('./article-release-api.ts');
  const task = {
    id: 'task-a',
    articleId: 'article-a',
    operation: 'publish',
    revision: 3,
    state: 'QUEUED',
    requestedAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    error: null,
  };
  assert.equal(readArticleReleaseResponse({ task }, 'article-a', 3)?.id, 'task-a');
  assert.throws(() => readArticleReleaseResponse({ task }, 'article-b'));
  assert.throws(() => readArticleReleaseResponse({ task }, 'article-a', 4));
  assert.throws(() =>
    readArticleReleaseResponse({ task: { ...task, candidate: { private: true } } }, 'article-a'),
  );
});
