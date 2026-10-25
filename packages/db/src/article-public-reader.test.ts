import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import { createCloudBasePublicArticles } from './article-public-reader.ts';
import { createCloudBaseArticleRepository } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';

const content = parseArticleContent({
  title: 'Public guide',
  slug: 'public-guide',
  authorName: 'Sean',
  excerpt: 'Guide summary',
  body: {
    schemaVersion: 1,
    document: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Public body' }] }],
    },
  },
});
const storage = {
  getObjectAsBase64: async () => {
    throw Error('unexpected storage read');
  },
};
test('real SDK writes and reads the publication without exposing private drafts', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const reader = createCloudBasePublicArticles(f.db, storage);
  const draft = await repo.create({ actorId: 'admin', requestId: 'new', content });
  assert.equal(await reader.get('public-guide'), null);
  assert.deepEqual(await reader.list(), { articles: [], next: null });
  const published = await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'publish',
  });
  assert.equal(published.state, 'SUCCEEDED');
  const article = await reader.get('public-guide');
  assert.equal(article?.content.title, content.title);
  const list = await reader.list();
  assert.equal(list.articles.length, 1);
  assert.equal(list.articles[0]?.articleId, draft.id);
  assert(!JSON.stringify(list).includes('Public body'));
  assert(!JSON.stringify(article).includes('createdBy'));
  await repo.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: 1,
    content: { ...content, title: 'Private work in progress' },
  });
  assert.equal((await reader.get('public-guide'))?.content.title, content.title);
  await repo.releases.request('admin', {
    operation: 'withdraw',
    articleId: draft.id,
    expectedRevision: 2,
    requestId: 'withdraw',
  });
  assert.equal(await reader.get('public-guide'), null);
  assert.equal((await reader.list()).articles.length, 0);
});

test('real SDK pagination returns twelve bounded summaries without documents or duplicates', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const reader = createCloudBasePublicArticles(f.db, storage);
  for (let i = 0; i < 14; i++) {
    const draft = await repo.create({
      actorId: 'admin',
      requestId: `draft-${i}`,
      content: { ...content, slug: `public-guide-${i}` },
    });
    await repo.releases.request('admin', {
      operation: 'publish',
      articleId: draft.id,
      expectedRevision: 1,
      requestId: `publish-${i}`,
    });
  }
  const first = await reader.list();
  assert.equal(first.articles.length, 12);
  assert(first.next);
  const second = await reader.list(first.next);
  assert.equal(second.articles.length, 2);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.articles, ...second.articles].map((a) => a.articleId)).size, 14);
  const calls = f.calls.filter((c) => c.api === 'database.getDocument' && c.params.projection);
  assert(calls.length >= 2);
  for (const call of calls) assert(!String(call.params.projection).includes('body'));
});

test('commit errors and malformed records cannot masquerade as a successful publish or empty list', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const reader = createCloudBasePublicArticles(f.db, storage);
  const draft = await repo.create({ actorId: 'admin', requestId: 'new', content });
  f.control.failNextCommit = true;
  await assert.rejects(
    repo.releases.request('admin', {
      operation: 'publish',
      articleId: draft.id,
      expectedRevision: 1,
      requestId: 'publish',
    }),
  );
  assert.equal(await reader.get('public-guide'), null);
  f.control.returnedReadError = true;
  await assert.rejects(reader.list());
});

test('public images require an accepted reference and are checked again after downloading', async (t) => {
  const f = articleSdkFixture(t);
  const bytes = Buffer.from('verified bytes');
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const draft = await repo.create({
    actorId: 'admin',
    requestId: 'image-draft',
    content: parseArticleContent({
      ...content,
      body: {
        schemaVersion: 1,
        document: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Image guide' }] },
            { type: 'articleImage', attrs: { mediaId: 'image-one', alt: 'Factory', caption: '' } },
          ],
        },
      },
    }),
  });
  const target = { storageFileId: 'cloud://private/image-one', storagePath: 'articles/image-one' };
  f.put('articleMedia', 'image-one', {
    id: 'image-one',
    articleId: draft.id,
    purpose: 'article-image',
    requestHash: 'a'.repeat(64),
    createdBy: 'admin',
    createdAt: draft.createdAt,
    expiresAt: new Date(Date.now() + 100000).toISOString(),
    pendingStorage: target,
    storage: target,
    status: 'active',
    fileName: 'photo.png',
    mimeType: 'image/png',
    byteSize: bytes.length,
    checksumSha256,
    width: 2,
    height: 2,
  });
  let withdraw = false;
  let reads = 0;
  const reader = createCloudBasePublicArticles(f.db, {
    getObjectAsBase64: async () => {
      reads++;
      if (withdraw)
        await repo.releases.request('admin', {
          operation: 'withdraw',
          articleId: draft.id,
          expectedRevision: 1,
          requestId: 'withdraw',
        });
      return { body: bytes.toString('base64') };
    },
  });
  const file = `${checksumSha256}.png`;
  assert.equal(await reader.media('image-one', file), null);
  assert.equal(reads, 0);
  await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'publish',
  });
  assert.deepEqual(await reader.media('image-one', file), {
    body: bytes.toString('base64'),
    mimeType: 'image/png',
  });
  withdraw = true;
  assert.equal(await reader.media('image-one', file), null);
  assert.equal(reads, 2);
});
