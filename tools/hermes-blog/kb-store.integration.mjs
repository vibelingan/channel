import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleArticleImportEvent } from '../../apps/functions/article-import/src/http-adapter.ts';
import { createArticleImportService } from '../../packages/articles/src/import-store.ts';
import {
  articleTransaction,
  createCloudBaseArticleRepository,
} from '../../packages/db/src/article-repository.ts';
import { articleSdkFixture } from '../../packages/db/src/article-sdk-fixture.test-helper.ts';
import { kbDraftRequest } from './kb-draft.mjs';
import { maintainCredentialFile } from './maintenance.mjs';

test('real SDK, HTTP adapter and maintenance recover the candidate-key 401 without masking it as a storage failure', async (t) => {
  const f = articleSdkFixture(t);
  const now = Date.parse('2026-10-27T00:00:00Z');
  const secret = 'f'.repeat(64);
  const key = 'formal-key';
  f.put('articleIntegrations', key, {
    _id: key,
    siteId: 'supplychainsai.com',
    integrationId: 'formal-connection',
    enabled: true,
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    expiresAt: new Date(now + 90 * 86400000).toISOString(),
    configRevision: 1,
  });
  f.put('articleIntegrations', `managed-${key}`, {
    _id: `managed-${key}`,
    siteId: 'supplychainsai.com',
    keyId: key,
    integrationId: 'formal-connection',
    rotateAfter: new Date(now).toISOString(),
  });
  const service = createArticleImportService(articleTransaction(f.db), () => now);
  const root = await mkdtemp(join(tmpdir(), 'real-sdk-maintenance-'));
  t.after(() => rm(root, { recursive: true }));
  const path = join(root, 'credential.json');
  const origin =
    'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com';
  await writeFile(
    path,
    JSON.stringify({
      CHANNEL_BLOG_API_ORIGIN: origin,
      CHANNEL_BLOG_SITE_ORIGIN: 'https://supplychainsai.com',
      CHANNEL_BLOG_INTEGRATION_ID: 'formal-connection',
      CHANNEL_BLOG_CREDENTIAL: `${key}.${secret}`,
      CHANNEL_BLOG_MAINTENANCE: {
        expiresAt: new Date(now + 90 * 86400000).toISOString(),
        rotateAfter: new Date(now).toISOString(),
        configRevision: 1,
      },
    }),
    { mode: 0o600 },
  );
  const statuses = [];
  const result = await maintainCredentialFile(path, {
    clock: () => now,
    request: async (method, url, options) => {
      assert.equal(url, `${origin}/api/integrations/v1/article-drafts/credential-rotation`);
      const response = await handleArticleImportEvent(
        {
          httpMethod: method,
          path: new URL(url).pathname,
          headers: options.headers,
          body: options.body.toString('utf8'),
        },
        service,
        'a'.repeat(40),
      );
      statuses.push(response.statusCode);
      return {
        status: response.statusCode,
        body: Buffer.from(response.body),
        headers: new Headers(response.headers),
      };
    },
  });
  assert.deepEqual(statuses, [401, 200]);
  assert.equal(result.configRevision, 2);
  assert.notEqual(result.config.credential, `${key}.${secret}`);
  const early = await handleArticleImportEvent(
    {
      httpMethod: 'POST',
      path: '/api/integrations/v1/article-drafts/credential-rotation',
      headers: {
        authorization: `Bearer ${result.config.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ rotationId: 'e'.repeat(32) }),
    },
    service,
    'a'.repeat(40),
  );
  assert.equal(early.statusCode, 429);
});

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
