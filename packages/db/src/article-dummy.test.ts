import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import {
  BLOG_DUMMY_COLLECTIONS,
  blogDummyCollection,
  createBlogDummyDatabase,
} from './article-dummy.ts';
import { createCloudBaseArticleRepository } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';

test('dummy transactions use only the fixed namespace; real users, products and article collections remain untouched', async (t) => {
  const f = articleSdkFixture(t);
  const db = createBlogDummyDatabase(f.db, 'offline-article-contract');
  f.put(BLOG_DUMMY_COLLECTIONS.users, 'dummy-admin', { role: 'admin', status: 'active' });
  const repository = createCloudBaseArticleRepository(db);
  const draft = await repository.create({
    actorId: 'dummy-admin',
    requestId: 'create',
    content: parseArticleContent({
      title: 'Dummy',
      slug: 'dummy',
      authorName: 'Sean',
      body: {
        schemaVersion: 1,
        document: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dummy isolation.' }] }],
        },
      },
    }),
  });
  await repository.releases?.request('dummy-admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'publish',
  });
  assert(f.rows.has(`${BLOG_DUMMY_COLLECTIONS.articleDrafts}/${draft.id}`));
  assert.equal(f.rows.size, 7);
  const names: readonly string[] = Object.values(BLOG_DUMMY_COLLECTIONS);
  const calls = f.calls.filter((call) => call.params.collectionName);
  assert(calls.length > 5);
  assert(calls.every((call) => names.includes(String(call.params.collectionName))));
  assert.throws(() => db.collection('products'), /outside/);
  await assert.rejects(
    db.runTransaction(async (tx) => tx.collection('users-real').doc('admin').get()),
    /outside/,
  );
  assert.throws(() => createBlogDummyDatabase(f.db, 'foreign-env'), /environment/);
  assert.throws(() => blogDummyCollection('__proto__'), /outside/);
  assert.throws(() => blogDummyCollection('blogDummy20261023Users'), /outside/);
});
