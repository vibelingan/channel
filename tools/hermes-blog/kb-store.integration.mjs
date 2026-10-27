import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createArticleImportService } from '../../packages/articles/src/import-store.ts';
import {
  articleTransaction,
  createCloudBaseArticleRepository,
} from '../../packages/db/src/article-repository.ts';
import { articleSdkFixture } from '../../packages/db/src/article-sdk-fixture.test-helper.ts';
import { kbDraftRequest } from './kb-draft.mjs';

test('KB identity, actual SDK transactions, human edits and rotated credentials keep one draft per document', async (t) => {
  const f = articleSdkFixture(t);
  const now = Date.parse('2026-10-27T00:00:00Z');
  const secret = 'f'.repeat(64);
  const credential = `formal-key.${secret}`;
  const binding = {
    siteId: 'supplychainsai.com',
    integrationId: 'formal-connection',
    workspaceId: 'customer-one',
  };
  f.put('articleIntegrations', 'formal-key', {
    _id: 'formal-key',
    siteId: binding.siteId,
    integrationId: binding.integrationId,
    enabled: true,
    expiresAt: new Date(now + 90 * 86400000).toISOString(),
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    configRevision: 1,
  });
  f.put('articleIntegrations', 'managed-formal-key', {
    _id: 'managed-formal-key',
    siteId: binding.siteId,
    integrationId: binding.integrationId,
    keyId: 'formal-key',
    rotateAfter: new Date(now).toISOString(),
  });
  const service = createArticleImportService(articleTransaction(f.db), () => now);
  const source = {
    documentId: 42,
    workspaceId: binding.workspaceId,
    article: {
      title: 'A useful article',
      format: 'markdown',
      body: '## Before ordering\n\nConfirm your requirements.',
    },
  };
  const firstInput = kbDraftRequest(binding, source);
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => service.create(credential, firstInput)),
  );
  assert.equal(new Set(concurrent.map((r) => r.articleId)).size, 1);
  assert.equal(concurrent.filter((r) => !r.replayed).length, 1);
  const first = concurrent[0];
  const repo = createCloudBaseArticleRepository(f.db);
  const draft = await repo.get({ actorId: 'admin', articleId: first.articleId });
  await repo.save({
    actorId: 'admin',
    articleId: first.articleId,
    expectedRevision: 1,
    content: { ...draft.content, title: 'Human revised title' },
  });
  const rotated = await service.rotate(credential, { rotationId: 'a'.repeat(32) });
  assert.equal(
    (await service.create(rotated.credential, kbDraftRequest(binding, source))).articleId,
    first.articleId,
  );
  const changed = kbDraftRequest(binding, {
    ...source,
    article: { ...source.article, title: 'KB revision' },
  });
  await assert.rejects(service.create(rotated.credential, changed), { code: 'CONFLICT' });
  assert.equal((await repo.get({ actorId: 'admin', articleId: first.articleId })).revision, 2);
  assert.equal(
    (await repo.get({ actorId: 'admin', articleId: first.articleId })).content.title,
    'Human revised title',
  );
  const second = await service.create(
    rotated.credential,
    kbDraftRequest(binding, { ...source, documentId: 43 }),
  );
  assert.notEqual(second.articleId, first.articleId);
  assert.equal([...f.rows.keys()].filter((key) => key.startsWith('articleDrafts/')).length, 2);
});

test('concurrent same-rotation retries commit one new credential through actual SDK conflict retries', async (t) => {
  const f = articleSdkFixture(t);
  const now = Date.parse('2026-10-27T00:00:00Z');
  const secret = 'f'.repeat(64);
  f.put('articleIntegrations', 'formal-key', {
    _id: 'formal-key',
    siteId: 'supplychainsai.com',
    integrationId: 'formal-connection',
    enabled: true,
    expiresAt: new Date(now + 90 * 86400000).toISOString(),
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    configRevision: 1,
  });
  f.put('articleIntegrations', 'managed-formal-key', {
    _id: 'managed-formal-key',
    siteId: 'supplychainsai.com',
    integrationId: 'formal-connection',
    keyId: 'formal-key',
    rotateAfter: new Date(now).toISOString(),
  });
  const service = createArticleImportService(articleTransaction(f.db), () => now);
  const replies = await Promise.all(
    Array.from({ length: 8 }, () =>
      service.rotate(`formal-key.${secret}`, { rotationId: 'b'.repeat(32) }),
    ),
  );
  assert.equal(new Set(replies.map((r) => r.credential)).size, 1);
  assert(replies.every((r) => r.configRevision === 2));
});

test('a failed SDK commit or zero write leaves both credential records unchanged', async (t) => {
  const f = articleSdkFixture(t);
  const now = Date.parse('2026-10-27T00:00:00Z');
  const secret = 'f'.repeat(64);
  f.put('articleIntegrations', 'formal-key', {
    _id: 'formal-key',
    siteId: 'supplychainsai.com',
    integrationId: 'formal-connection',
    enabled: true,
    expiresAt: new Date(now + 90 * 86400000).toISOString(),
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    configRevision: 1,
  });
  f.put('articleIntegrations', 'managed-formal-key', {
    _id: 'managed-formal-key',
    siteId: 'supplychainsai.com',
    integrationId: 'formal-connection',
    keyId: 'formal-key',
    rotateAfter: new Date(now).toISOString(),
  });
  const service = createArticleImportService(articleTransaction(f.db), () => now);
  const before = structuredClone(f.rows);
  for (const fault of ['failNextCommit', 'zeroNextWrite']) {
    f.control[fault] = true;
    await assert.rejects(service.rotate(`formal-key.${secret}`, { rotationId: 'c'.repeat(32) }), {
      code: 'UNAVAILABLE',
    });
    assert.deepEqual(f.rows, before);
  }
});
