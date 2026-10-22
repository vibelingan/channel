import assert from 'node:assert/strict';
import test from 'node:test';
import { createArticleDraft, prepareArticlePublication, saveArticleDraft } from './drafts.ts';

const t1 = '2026-10-22T08:00:00.000Z';
const t2 = '2026-10-22T08:01:00.000Z';
const content = () => ({
  title: 'Choosing a hub',
  slug: 'choosing-a-hub',
  authorName: 'Sean',
  body: {
    schemaVersion: 1,
    document: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Compare the ports.' }] }],
    },
  },
});
const create = () =>
  createArticleDraft({ id: 'article-1', editorId: 'editor-1', now: t1, content: content() });

test('a blank draft is allowed but cannot become a publication candidate', () => {
  const draft = createArticleDraft({
    id: 'article-1',
    editorId: 'editor-1',
    now: t1,
    content: {
      title: '',
      slug: '',
      body: { schemaVersion: 1, document: { type: 'doc', content: [] } },
    },
  });
  assert.equal(draft.revision, 1);
  assert.equal(draft.published, null);
  assert.throws(() => prepareArticlePublication(draft, t2));
});

test('saving requires the current revision and preserves the caller and published version', () => {
  const draft = {
    ...create(),
    published: {
      revision: 1,
      slug: 'choosing-a-hub',
      contentHash: 'a'.repeat(64),
      publishedAt: t1,
      modifiedAt: t1,
    },
  };
  const changed = saveArticleDraft(draft, {
    expectedRevision: 1,
    editorId: 'editor-2',
    now: t2,
    content: { ...content(), title: 'New title' },
  });
  assert.equal(changed.revision, 2);
  assert.equal(draft.revision, 1);
  assert.equal(draft.content.title, 'Choosing a hub');
  assert.deepEqual(changed.published, draft.published);
  assert.throws(() =>
    saveArticleDraft(changed, {
      expectedRevision: 1,
      editorId: 'editor-1',
      now: t2,
      content: content(),
    }),
  );
});

test('identical saves do not advance the revision, timestamps or editor', () => {
  const draft = create();
  assert.deepEqual(
    saveArticleDraft(draft, {
      expectedRevision: 1,
      editorId: 'editor-2',
      now: t2,
      content: content(),
    }),
    draft,
  );
});

test('frozen candidates survive later draft edits without pretending to be published', () => {
  const draft = create();
  const candidate = prepareArticlePublication(draft, t2);
  const changed = saveArticleDraft(draft, {
    expectedRevision: 1,
    editorId: 'editor-2',
    now: t2,
    content: { ...content(), title: 'Later title' },
  });
  assert.equal(candidate.revision, 1);
  assert.equal(candidate.content.title, 'Choosing a hub');
  assert.equal(changed.content.title, 'Later title');
  assert.equal(changed.published, null);
  assert(!('publishedAt' in candidate));
  assert.equal(
    candidate.contentHash,
    prepareArticlePublication(draft, '2026-10-22T08:02:00.000Z').contentHash,
  );
});

test('a candidate cannot be mutated and is independent from the caller document', () => {
  const draft = create();
  const candidate = prepareArticlePublication(draft, t2);
  assert(Object.isFrozen(candidate));
  assert(Object.isFrozen(candidate.content.body.document.content));
  assert.equal(Reflect.set(candidate.content, 'title', 'Tampered'), false);
  draft.content.title = 'Changed outside the publisher';
  draft.content.body.document.content.length = 0;
  assert.equal(candidate.content.title, 'Choosing a hub');
  assert.equal(candidate.content.body.document.content.length, 1);
});

for (const [label, patch] of [
  ['missing title', { title: '' }],
  ['missing author', { authorName: '' }],
  ['invalid slug', { slug: '../admin' }],
  ['empty body', { body: { schemaVersion: 1, document: { type: 'doc', content: [] } } }],
] as const)
  test(`publication refuses ${label}`, () => {
    assert.throws(() =>
      prepareArticlePublication(
        createArticleDraft({
          id: 'article-1',
          editorId: 'editor-1',
          now: t1,
          content: { ...content(), ...patch },
        }),
        t2,
      ),
    );
  });

test('a published address cannot be silently replaced by an edited slug', () => {
  const draft = {
    ...create(),
    published: {
      revision: 1,
      slug: 'original-address',
      contentHash: 'a'.repeat(64),
      publishedAt: t1,
      modifiedAt: t1,
    },
  };
  assert.throws(() => prepareArticlePublication(draft, t2));
});

test('client publication fields, invalid clocks and exhausted revisions fail closed', () => {
  assert.throws(() =>
    createArticleDraft({
      id: 'article-1',
      editorId: 'editor-1',
      now: t1,
      content: { ...content(), published: true },
    }),
  );
  const draft = create();
  assert.throws(() =>
    saveArticleDraft(draft, {
      expectedRevision: 1,
      editorId: 'editor-1',
      now: 'invalid',
      content: content(),
    }),
  );
  assert.throws(() =>
    saveArticleDraft(draft, {
      expectedRevision: 1,
      editorId: 'editor-1',
      now: '2026-10-21T00:00:00.000Z',
      content: content(),
    }),
  );
  assert.throws(() =>
    saveArticleDraft(
      { ...draft, revision: Number.MAX_SAFE_INTEGER },
      {
        expectedRevision: Number.MAX_SAFE_INTEGER,
        editorId: 'editor-1',
        now: t2,
        content: { ...content(), title: 'Changed' },
      },
    ),
  );
});
