import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import { prepareArticlePublication } from '@vibelingan-channel/articles/drafts';
import { JsonFileAdapter } from './json-adapter.ts';

function setup(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), 'channel-article-repository-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'db.json');
  writeFileSync(file, JSON.stringify({ users: [{ _id: 'admin', role: 'admin' }] }));
  return { file, adapter: new JsonFileAdapter(file) };
}

const articleContent = () =>
  parseArticleContent({
    title: 'Published title',
    slug: 'published-title',
    authorName: 'Author',
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Published body' }] }],
      },
    },
  });

test('editing a draft preserves its publication reference and immutable saved snapshot', async (t) => {
  const { file, adapter } = setup(t);
  const draft = await adapter.articleRepository.create({
    actorId: 'admin',
    requestId: 'publication',
    content: articleContent(),
  });
  const candidate = prepareArticlePublication(draft, draft.updatedAt);
  const publication = {
    revision: 1,
    slug: 'published-title',
    contentHash: candidate.contentHash,
    publishedAt: draft.updatedAt,
    modifiedAt: draft.updatedAt,
  };
  const store = JSON.parse(readFileSync(file, 'utf8'));
  store.articleDrafts[0].draft.published = publication;
  store.articlePublications = [{ _id: `${draft.id}:1`, candidate }];
  writeFileSync(file, JSON.stringify(store));
  const saved = await adapter.articleRepository.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: 1,
    content: { ...articleContent(), title: 'Unpublished edit' },
  });
  assert.ok(saved);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.published, publication);
  assert.equal(
    typeof adapter.articleRepository.getPublication,
    'function',
    'The repository must read a specified immutable snapshot',
  );
  const snapshot = await adapter.articleRepository.getPublication({
    actorId: 'admin',
    articleId: draft.id,
    revision: 1,
  });
  assert.deepEqual(snapshot, candidate);
  assert.equal(snapshot?.content.title, 'Published title');
  assert.ok(Object.isFrozen(snapshot?.content));
  assert.equal(
    await adapter.articleRepository.getPublication({
      actorId: 'admin',
      articleId: draft.id,
      revision: 2,
    }),
    null,
  );
  const damaged = JSON.parse(readFileSync(file, 'utf8'));
  damaged.articlePublications[0].candidate.content.title = 'Tampered snapshot';
  writeFileSync(file, JSON.stringify(damaged));
  await assert.rejects(
    adapter.articleRepository.getPublication({
      actorId: 'admin',
      articleId: draft.id,
      revision: 1,
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'INTERNAL_ERROR',
  );
});

test('a failed atomic file replacement leaves the original draft usable and can be retried', async (t) => {
  const { file, adapter } = setup(t);
  const draft = await adapter.articleRepository.create({
    actorId: 'admin',
    requestId: 'persist-failure',
    content: articleContent(),
  });
  const rename = fs.renameSync;
  const replacement = t.mock.method(
    fs,
    'renameSync',
    (...args: Parameters<typeof fs.renameSync>) => {
      if (args[1] === file) throw new Error('Synthetic storage full');
      return rename(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      adapter.articleRepository.save({
        actorId: 'admin',
        articleId: draft.id,
        expectedRevision: 1,
        content: { ...articleContent(), title: 'Failed edit' },
      }),
      /Synthetic storage full/,
    );
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(
    await adapter.articleRepository.get({ actorId: 'admin', articleId: draft.id }),
    draft,
  );
  const retried = await adapter.articleRepository.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: 1,
    content: { ...articleContent(), title: 'Retried edit' },
  });
  assert.equal(retried?.revision, 2);
  assert.equal(retried?.content.title, 'Retried edit');
});

test('repository writes enforce the record limit even for trusted internal callers', async (t) => {
  const { adapter } = setup(t);
  const large = articleContent();
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
    adapter.articleRepository.create({
      actorId: 'admin',
      requestId: 'record-limit',
      content: large,
    }),
    /384 KiB/,
  );
  const page = await adapter.articleRepository.list({ actorId: 'admin', limit: 20, query: '' });
  assert.deepEqual(page.items, []);
});

test('create deduplication is scoped to the current admin rather than another account', async (t) => {
  const { file, adapter } = setup(t);
  const store = JSON.parse(readFileSync(file, 'utf8'));
  store.users.push({ _id: 'other-admin', role: 'admin' });
  writeFileSync(file, JSON.stringify(store));
  const first = await adapter.articleRepository.create({
    actorId: 'admin',
    requestId: 'same-client-key',
    content: articleContent(),
  });
  const second = await adapter.articleRepository.create({
    actorId: 'other-admin',
    requestId: 'same-client-key',
    content: articleContent(),
  });
  assert.notEqual(first.id, second.id);
  assert.equal(second.createdBy, 'other-admin');
});
