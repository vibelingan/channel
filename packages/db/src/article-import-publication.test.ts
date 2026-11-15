import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { articleContentHash } from '@vibelingan-channel/articles/drafts';
import { prepareArticleImport } from '@vibelingan-channel/articles/import';
import {
  createArticleImportPublicationService,
  publicationAccessId,
} from '@vibelingan-channel/articles/import-publication';
import { createArticleImportService } from '@vibelingan-channel/articles/import-store';
import { articleTransaction, createCloudBaseArticleRepository } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
const secret = 'f'.repeat(64);
const credential = `publisher.${secret}`;
const now = Date.parse('2020-01-01T00:00:00.000Z');
const source = {
  idempotencyKey: 'publication-source',
  externalTaskId: 'publication-source',
  title: 'Approved company article',
  slug: 'approved-company-article',
  excerpt: 'An exact prepared article.',
  authorName: 'Diversity Technology Limited',
  format: 'markdown',
  body: '## Prepared article\n\nPublish this exact content when the customer asks.',
};
async function setup(t: Parameters<typeof articleSdkFixture>[0], grant = true) {
  const f = articleSdkFixture(t);
  const key = {
    _id: 'publisher',
    siteId: 'supplychainsai.com',
    integrationId: 'company-publisher',
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    enabled: true,
    expiresAt: '2030-01-01T00:00:00.000Z',
    configRevision: 1,
  };
  f.put('articleIntegrations', key._id, key);
  if (grant)
    f.put('articleIntegrations', publicationAccessId(key._id), {
      _id: publicationAccessId(key._id),
      siteId: key.siteId,
      keyId: key._id,
      integrationId: key.integrationId,
      enabled: true,
    });
  const transaction = articleTransaction(f.db);
  const imported = await createArticleImportService(transaction, () => now).create(
    credential,
    source,
  );
  const repo = createCloudBaseArticleRepository(f.db);
  const draft = await repo.get({ actorId: 'admin', articleId: imported.articleId });
  assert(draft);
  const publication = createArticleImportPublicationService(transaction, () => now + 1000);
  const request = {
    operation: 'publish',
    requestId: 'same-customer-message',
    expectedRevision: draft.revision,
    expectedContentHash: articleContentHash(draft.content),
    expectedSourceHash: prepareArticleImport(source).requestHash,
    approval: {
      decision: 'publish-now',
      messageRef: 'wecom:approved-group:123',
      instruction: 'Publish this prepared article on the company website.',
    },
  } as const;
  return { ...f, key, imported, repo, publication, request };
}
test('explicitly authorized publisher atomically publishes one owned article and preserves draft content', async (t) => {
  const f = await setup(t);
  const before = await f.repo.get({ actorId: 'admin', articleId: f.imported.articleId });
  const result = await f.publication.change(credential, f.imported.operationId, f.request);
  assert.equal(result.state, 'published');
  assert.equal(result.replayed, false);
  assert.equal(result.publicUrl, 'https://supplychainsai.com/blog/approved-company-article/');
  assert.equal(result.publishedContentHash, f.request.expectedContentHash);
  const after = await f.repo.get({ actorId: 'admin', articleId: f.imported.articleId });
  assert.deepEqual(after?.content, before?.content);
  assert.equal(after?.published?.revision, 1);
  assert.equal((await f.publication.state(credential, f.imported.operationId)).state, 'published');
});
test('concurrent same-message delivery creates one publication and one audit receipt', async (t) => {
  const f = await setup(t);
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.publication.change(credential, f.imported.operationId, f.request),
    ),
  );
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(new Set(results.map((r) => r.releaseId)).size, 1);
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleReleaseTasks/')).length, 1);
  assert.equal(
    [...f.rows.keys()].filter((k) => k.startsWith('articleImports/publication-request-')).length,
    1,
  );
});
test('existing draft key, revoked permission and foreign integration cannot publish', async (t) => {
  const f = await setup(t, false);
  const before = structuredClone(f.rows);
  await assert.rejects(f.publication.change(credential, f.imported.operationId, f.request), {
    code: 'UNAUTHORIZED',
  });
  assert.deepEqual(f.rows, before);
  f.put('articleIntegrations', publicationAccessId(f.key._id), {
    _id: publicationAccessId(f.key._id),
    siteId: f.key.siteId,
    keyId: f.key._id,
    integrationId: f.key.integrationId,
    enabled: false,
  });
  await assert.rejects(f.publication.change(credential, f.imported.operationId, f.request), {
    code: 'UNAUTHORIZED',
  });
  f.put('articleIntegrations', 'other', { ...f.key, _id: 'other', integrationId: 'other-company' });
  f.put('articleIntegrations', publicationAccessId('other'), {
    _id: publicationAccessId('other'),
    siteId: f.key.siteId,
    keyId: 'other',
    integrationId: 'other-company',
    enabled: true,
  });
  await assert.rejects(f.publication.state(`other.${secret}`, f.imported.operationId), {
    code: 'NOT_FOUND',
  });
});
test('human changes, a stale revision, wrong hash and changed same-message requests cannot publish', async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.publication.change(credential, f.imported.operationId, { ...f.request, expectedRevision: 2 }),
    { code: 'CONFLICT' },
  );
  await assert.rejects(
    f.publication.change(credential, f.imported.operationId, {
      ...f.request,
      expectedContentHash: '0'.repeat(64),
    }),
    { code: 'CONFLICT' },
  );
  const draft = await f.repo.get({ actorId: 'admin', articleId: f.imported.articleId });
  assert(draft);
  await f.repo.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: draft.revision,
    content: { ...draft.content, title: 'Human revised title' },
  });
  const changed = await f.repo.get({ actorId: 'admin', articleId: draft.id });
  assert(changed);
  const before = structuredClone(f.rows);
  await assert.rejects(
    f.publication.change(credential, f.imported.operationId, {
      ...f.request,
      expectedRevision: changed.revision,
      expectedContentHash: articleContentHash(changed.content),
    }),
    { code: 'CONFLICT' },
  );
  assert.deepEqual(f.rows, before);
});
test('withdrawal removes the public projection; replaying an old publish does not resurrect content', async (t) => {
  const f = await setup(t);
  await f.publication.change(credential, f.imported.operationId, f.request);
  const withdrawn = await f.publication.change(credential, f.imported.operationId, {
    ...f.request,
    operation: 'withdraw',
    requestId: 'cleanup-message',
    approval: {
      ...f.request.approval,
      decision: 'withdraw-now',
      messageRef: 'operator:authorized-cleanup',
    },
  });
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.publicUrl, null);
  const replay = await f.publication.change(credential, f.imported.operationId, f.request);
  assert.equal(replay.state, 'withdrawn');
  assert.equal(replay.replayed, true);
  assert.equal(f.rows.get(`articleAccepted/${f.imported.articleId}`)?.publication, null);
  assert((await f.repo.get({ actorId: 'admin', articleId: f.imported.articleId }))?.content);
});
test('a failed commit leaves neither a public article nor a successful publication receipt', async (t) => {
  const f = await setup(t);
  const before = structuredClone(f.rows);
  f.control.failNextCommit = true;
  await assert.rejects(f.publication.change(credential, f.imported.operationId, f.request), {
    code: 'UNAVAILABLE',
  });
  assert.deepEqual(f.rows, before);
});

test('a publication request cannot be repurposed and expired keys cannot replay it', async (t) => {
  const f = await setup(t);
  await f.publication.change(credential, f.imported.operationId, f.request);
  const before = structuredClone(f.rows);
  await assert.rejects(
    f.publication.change(credential, f.imported.operationId, {
      ...f.request,
      operation: 'withdraw',
      approval: { ...f.request.approval, decision: 'withdraw-now' },
    }),
    { code: 'CONFLICT' },
  );
  assert.deepEqual(f.rows, before);
  f.put('articleIntegrations', f.key._id, { ...f.key, expiresAt: '2019-01-01T00:00:00.000Z' });
  await assert.rejects(f.publication.change(credential, f.imported.operationId, f.request), {
    code: 'UNAUTHORIZED',
  });
});

test('publication quota is not charged again for a same-message replay', async (t) => {
  const f = await setup(t);
  await f.publication.change(credential, f.imported.operationId, f.request);
  const before = structuredClone(f.rows);
  await f.publication.change(credential, f.imported.operationId, f.request);
  assert.deepEqual(f.rows, before);
  const counters = [...f.rows.entries()].filter(([k]) =>
    k.startsWith('articleImportLimits/publication-limit-'),
  );
  assert.equal(counters.length, 2);
  assert(counters.every(([, r]) => r.count === 1));
});

test('source changes update the same owned draft without publishing, duplicating or losing links and tables', async (t) => {
  const f = await setup(t);
  const input = {
    requestId: 'exact-source-update',
    expectedRevision: 1,
    expectedContentHash: f.request.expectedContentHash,
    expectedSourceHash: f.request.expectedSourceHash,
    source: {
      ...source,
      authorName: 'SupplyChainsAI',
      body: '## Exact prepared text\n\n[Project examples](https://supplychainsai.com/portfolio/)\n\n| Item | Value |\n| --- | --- |\n| Original | Preserved |',
    },
  };
  const updated = await f.publication.sync(credential, f.imported.operationId, input);
  assert.equal(updated.articleId, f.imported.articleId);
  assert.equal(updated.revision, 2);
  assert.equal(updated.state, 'ready');
  const draft = await f.repo.get({ actorId: 'admin', articleId: f.imported.articleId });
  assert(draft);
  assert.equal(draft.content.authorName, 'SupplyChainsAI');
  assert.equal(draft.published, null);
  assert(draft.content.body.document.content.some((x) => x.type === 'table'));
  assert(JSON.stringify(draft.content.body).includes('https://supplychainsai.com/portfolio/'));
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleDrafts/')).length, 1);
  const before = structuredClone(f.rows);
  assert.equal((await f.publication.sync(credential, f.imported.operationId, input)).revision, 2);
  assert.deepEqual(f.rows, before);
  const published = await f.publication.change(credential, f.imported.operationId, {
    ...f.request,
    expectedRevision: updated.revision,
    expectedContentHash: updated.contentHash,
    expectedSourceHash: updated.sourceHash,
  });
  assert.equal(published.publishedRevision, 2);
});
