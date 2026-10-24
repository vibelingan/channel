import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOwnedArticleDrill } from './release/site-acceptance-scope.mjs';
test('fault injection refuses customer tasks or mismatched ownership before any task claim', () => {
  const taskId = `release-${'a'.repeat(64)}`;
  const task = {
    _id: taskId,
    id: taskId,
    state: 'QUEUED',
    slug: 'oem-project-brief-acceptance-123',
    articleId: 'own-article',
  };
  const draft = {
    id: 'own-article',
    content: {
      slug: task.slug,
      title: 'Preparing an OEM headphone project brief',
      authorName: 'Diversity Technology Limited',
    },
  };
  assertOwnedArticleDrill({ taskId, task, draft });
  for (const changed of [
    { ...task, slug: 'customer-article' },
    { ...task, articleId: 'different' },
    { ...task, state: 'SUCCEEDED' },
    { ...task, _id: `release-${'b'.repeat(64)}` },
  ])
    assert.throws(() => assertOwnedArticleDrill({ taskId, task: changed, draft }));
  assert.throws(() =>
    assertOwnedArticleDrill({
      taskId,
      task,
      draft: { ...draft, content: { ...draft.content, title: 'Customer copy' } },
    }),
  );
});
