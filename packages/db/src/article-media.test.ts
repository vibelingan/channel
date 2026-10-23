import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import type { ArticleMediaRecord } from '@vibelingan-channel/articles/media';
import { createCloudBaseArticleRepository } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';

async function setup(t: import('node:test').TestContext) {
  const fixture = articleSdkFixture(t);
  fixture.put('users', 'admin', { role: 'admin' });
  const repository = createCloudBaseArticleRepository(fixture.db);
  const draft = await repository.create({
    actorId: 'admin',
    requestId: 'image-owner',
    content: parseArticleContent({
      title: 'Draft',
      slug: '',
      body: { schemaVersion: 1, document: { type: 'doc', content: [] } },
    }),
  });
  const record: Extract<ArticleMediaRecord, { status: 'pending' }> = {
    id: 'article-media-test',
    articleId: draft.id,
    purpose: 'article-image',
    fileName: 'image.png',
    mimeType: 'image/png',
    byteSize: 68,
    checksumSha256: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdBy: 'admin',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    pendingStorage: { storageFileId: 'cloud://test/pending', storagePath: 'articles/pending' },
    status: 'pending',
  };
  const media = repository.media;
  assert.ok(media);
  return { fixture, repository, draft, record, media };
}
test('actual SDK transactions reserve one article-owned image under concurrent retries', async (t) => {
  const f = await setup(t);
  const results = await Promise.all(
    [0, 1].map(() =>
      f.media.execute('admin', f.draft.id, { operation: 'reserve', record: f.record }),
    ),
  );
  assert.deepEqual(results[0], results[1]);
  assert.equal([...f.fixture.rows.keys()].filter((k) => k.startsWith('articleMedia/')).length, 1);
  assert.deepEqual(
    await f.media.execute('admin', f.draft.id, { operation: 'get', mediaId: f.record.id }),
    f.record,
  );
  await assert.rejects(
    f.media.execute('admin', f.draft.id, {
      operation: 'reserve',
      record: { ...f.record, requestHash: 'c'.repeat(64) },
    }),
    { code: 'CONFLICT' },
  );
});
test('actual SDK transactions activate once, preserve canonical bytes, and reject foreign article ownership', async (t) => {
  const f = await setup(t);
  await f.media.execute('admin', f.draft.id, { operation: 'reserve', record: f.record });
  const active: ArticleMediaRecord = {
    ...f.record,
    status: 'active',
    storage: { storageFileId: 'cloud://test/canonical', storagePath: 'articles/canonical' },
    width: 1,
    height: 1,
  };
  const results = await Promise.all(
    [0, 1].map(() =>
      f.media.execute('admin', f.draft.id, { operation: 'activate', record: active }),
    ),
  );
  assert.deepEqual(results[0], active);
  assert.deepEqual(results[1], active);
  const other = await f.repository.create({
    actorId: 'admin',
    requestId: 'other-owner',
    content: f.draft.content,
  });
  await assert.rejects(
    f.media.execute('admin', other.id, { operation: 'get', mediaId: f.record.id }),
    { code: 'NOT_FOUND' },
  );
  assert.ok(
    f.fixture.calls
      .filter((c) => c.api === 'database.modifyDocument')
      .every((c) => c.params.merge === false),
  );
});
test('actual SDK media writes fail closed on missing acknowledgements and commit failure', async (t) => {
  for (const failure of ['zeroNextWrite', 'failNextCommit'] as const) {
    const f = await setup(t);
    f.fixture.control[failure] = true;
    await assert.rejects(
      f.media.execute('admin', f.draft.id, { operation: 'reserve', record: f.record }),
      { code: 'INTERNAL_ERROR' },
    );
    assert.equal(f.fixture.rows.has(`articleMedia/${f.record.id}`), false);
  }
});
test('actual SDK media transaction rechecks a demoted account and corrupt media cannot be returned', async (t) => {
  const f = await setup(t);
  await f.media.execute('admin', f.draft.id, { operation: 'reserve', record: f.record });
  f.fixture.put('users', 'admin', { role: 'contributor' });
  await assert.rejects(
    f.media.execute('admin', f.draft.id, { operation: 'get', mediaId: f.record.id }),
    { code: 'FORBIDDEN' },
  );
  f.fixture.put('users', 'admin', { role: 'admin' });
  f.fixture.put('articleMedia', f.record.id, { ...f.record, articleId: 'other' });
  await assert.rejects(
    f.media.execute('admin', f.draft.id, { operation: 'get', mediaId: f.record.id }),
    { code: 'NOT_FOUND' },
  );
  f.fixture.put('articleMedia', f.record.id, { ...f.record, status: 'corrupt' });
  await assert.rejects(
    f.media.execute('admin', f.draft.id, { operation: 'get', mediaId: f.record.id }),
    { code: 'INTERNAL_ERROR' },
  );
});
