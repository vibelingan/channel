import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArticleBuildCandidate, prepareArticleBuild } from './build.ts';
import { articleContentHash, createArticleDraft, prepareArticlePublication } from './drafts.ts';
import { parsePublishedArticle } from './publication.ts';

const time = '2026-10-23T10:00:00.000Z';
function fixture() {
  const frozen = prepareArticlePublication(
    createArticleDraft({
      id: 'article-one',
      editorId: 'admin',
      now: time,
      content: {
        title: 'Manufacturing guide',
        slug: 'manufacturing-guide',
        authorName: 'Editor',
        body: {
          schemaVersion: 1,
          document: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original body' }] }],
          },
        },
      },
    }),
    time,
  );
  const accepted = parsePublishedArticle({
    status: 'accepted',
    deliveryId: 'delivery-one',
    articleId: frozen.articleId,
    revision: frozen.revision,
    content: frozen.content,
    contentHash: frozen.contentHash,
    publishedAt: time,
    modifiedAt: time,
    acceptedAt: time,
    media: {},
  });
  return accepted;
}
function candidate() {
  const { status: _status, deliveryId: _deliveryId, acceptedAt: _acceptedAt, ...data } = fixture();
  const content = { ...data.content, title: 'Updated manufacturing guide' };
  return {
    status: 'candidate',
    taskId: 'task-one',
    ...data,
    revision: 2,
    content,
    contentHash: articleContentHash(content),
    modifiedAt: '2026-10-23T11:00:00.000Z',
  };
}
const request = () => ({
  schemaVersion: 1,
  purpose: 'article-release',
  taskId: 'task-one',
  operation: 'publish',
  articleId: 'article-one',
  revision: 2,
  accepted: [fixture()],
  candidate: candidate(),
});

test('candidate build replaces only the selected article; public parser still rejects candidates', () => {
  const other = {
    ...fixture(),
    articleId: 'article-two',
    content: { ...fixture().content, slug: 'another-guide' },
  };
  other.contentHash = articleContentHash(other.content);
  const input = { ...request(), accepted: [fixture(), other] };
  const built = prepareArticleBuild(input, 'task-one');
  assert.equal(built.length, 2);
  assert.equal(
    built.find((a) => a.articleId === 'article-one')?.content.title,
    'Updated manufacturing guide',
  );
  assert.deepEqual(
    built.find((a) => a.articleId === 'article-two'),
    other,
  );
  assert.throws(() => parsePublishedArticle(candidate()));
  assert.throws(() => prepareArticleBuild(input, 'another-task'));
});

test('withdraw builds without the article and requires its accepted identity', () => {
  assert.deepEqual(
    prepareArticleBuild({ ...request(), operation: 'withdraw', candidate: null }, 'task-one'),
    [],
  );
  assert.throws(() =>
    prepareArticleBuild(
      { ...request(), operation: 'withdraw', candidate: null, accepted: [] },
      'task-one',
    ),
  );
  assert.throws(() => prepareArticleBuild({ ...request(), operation: 'withdraw' }, 'task-one'));
});

test('build rejects task substitution, duplicate URLs, stale versions and private fields', () => {
  for (const candidateChange of [
    { taskId: 'wrong-task' },
    { articleId: 'other' },
    { revision: 1 },
    { storage: 'cloud://secret' },
    { contentHash: 'a'.repeat(64) },
    { modifiedAt: '2026-10-22T10:00:00.000Z' },
    {
      content: { ...candidate().content, slug: 'changed-url' },
      contentHash: articleContentHash({ ...candidate().content, slug: 'changed-url' }),
    },
  ])
    assert.throws(() =>
      prepareArticleBuild(
        { ...request(), candidate: { ...candidate(), ...candidateChange } },
        'task-one',
      ),
    );
  assert.throws(() =>
    prepareArticleBuild({ ...request(), accepted: [fixture(), fixture()] }, 'task-one'),
  );
  assert.throws(() => parseArticleBuildCandidate({ ...candidate(), acceptedAt: time }));
  assert.throws(() =>
    prepareArticleBuild(
      { ...request(), accepted: [{ ...fixture(), status: 'candidate' }] },
      'task-one',
    ),
  );
});
