import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { handleArticleImportEvent } from '../../apps/functions/article-import/src/http-adapter.ts';
import {
  createArticleImportPublicationService,
  publicationAccessId,
} from '../../packages/articles/src/import-publication.ts';
import { createArticleImportService } from '../../packages/articles/src/import-store.ts';
import { prepareArticleImport } from '../../packages/articles/src/import.ts';
import {
  articleTransaction,
  createCloudBaseArticleRepository,
} from '../../packages/db/src/article-repository.ts';
import { articleSdkFixture } from '../../packages/db/src/article-sdk-fixture.test-helper.ts';
import { BlogToolError, createBlogToolClient } from './client.mjs';
import { kbDraftRequest, kbSourceHash } from './kb-draft.mjs';
import { publishKbDocument } from './publication.mjs';
const binding = {
  siteId: 'supplychainsai.com',
  integrationId: 'publisher-integration',
  workspaceId: '2',
};
const secret = 'f'.repeat(64);
const credential = `publisher.${secret}`;
const now = Date.parse('2020-01-01T00:00:00Z');
const selected = {
  documentId: 42,
  workspaceId: '2',
  article: {
    title: 'Prepared article',
    slug: 'prepared-article',
    authorName: 'SupplyChainsAI',
    format: 'markdown',
    body: '## Introduction\n\nKeep the [business link](https://supplychainsai.com/oem/).\n\n| Topic | Value |\n| --- | --- |\n| Tooling | Existing facts |',
  },
};
const approval = {
  decision: 'publish-now',
  messageRef: 'wecom:customer:message-1',
  instruction: 'Publish this article on our company Blog.',
};
function fixture(t) {
  const f = articleSdkFixture(t);
  let visible = true;
  const calls = [];
  f.put('articleIntegrations', 'publisher', {
    _id: 'publisher',
    siteId: binding.siteId,
    integrationId: binding.integrationId,
    enabled: true,
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    expiresAt: '2030-01-01T00:00:00Z',
    configRevision: 1,
  });
  f.put('articleIntegrations', publicationAccessId('publisher'), {
    _id: publicationAccessId('publisher'),
    siteId: binding.siteId,
    keyId: 'publisher',
    integrationId: binding.integrationId,
    enabled: true,
  });
  const transaction = articleTransaction(f.db);
  const service = {
    ...createArticleImportService(transaction, () => now),
    publication: createArticleImportPublicationService(transaction, () => now + 1000),
  };
  const request = async (method, url, options) => {
    calls.push([method, new URL(url).pathname]);
    if (new URL(url).hostname === 'supplychainsai.com') {
      const row = [...f.rows.entries()].find(
        ([key, value]) => key.startsWith('articleAccepted/') && value.publication,
      )?.[1];
      const p = row?.publication;
      return {
        status: visible && p ? 200 : 503,
        headers: new Headers(),
        body: Buffer.from(
          p
            ? `<link rel="canonical" href="https://supplychainsai.com/blog/${p.content.slug}/"><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', headline: p.content.title, dateModified: p.modifiedAt })}</script>`
            : '',
        ),
      };
    }
    const r = await handleArticleImportEvent(
      {
        httpMethod: method,
        path: new URL(url).pathname,
        headers: options.headers,
        body: options.body?.toString() ?? '',
      },
      service,
    );
    return { status: r.statusCode, headers: new Headers(r.headers), body: Buffer.from(r.body) };
  };
  const client = createBlogToolClient(
    {
      apiOrigin:
        'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
      siteOrigin: 'https://supplychainsai.com',
      integrationId: binding.integrationId,
      credential,
    },
    { request, pause: async () => {} },
  );
  return {
    ...f,
    client,
    calls,
    request,
    repo: createCloudBaseArticleRepository(f.db),
    hide: () => {
      visible = false;
    },
  };
}
test('source hash matches the actual server converter for Unicode, metadata defaults and newlines', () => {
  for (const article of [
    selected.article,
    {
      ...selected.article,
      title: '  Café\r\nTitle ',
      excerpt: ' e\u0301 ',
      body: '## Topic\r\n\r\nOriginal e\u0301 text.\n',
    },
  ]) {
    const source = kbDraftRequest(binding, { ...selected, article });
    assert.equal(kbSourceHash(source), prepareArticleImport(source).requestHash);
  }
});
test('publisher creates one missing draft then publishes exact tables/links/author; retry reuses it and withdraws without old request resurrection', async (t) => {
  const f = fixture(t);
  const run = (a = approval) =>
    publishKbDocument(f.client, binding, selected, a, { request: f.request });
  const first = await run();
  assert(first.publicVerified);
  assert.equal(first.state, 'published');
  assert.equal(f.calls.length, 5); // state 404, create, state, publish, public HTML
  const draft = await f.repo.get({ actorId: 'admin', articleId: first.articleId });
  assert.equal(draft.content.authorName, 'SupplyChainsAI');
  assert(JSON.stringify(draft.content.body).includes('table'));
  assert(JSON.stringify(draft.content.body).includes('https://supplychainsai.com/oem/'));
  const again = await run();
  assert.equal(again.articleId, first.articleId);
  assert(again.alreadyPublished);
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleDrafts/')).length, 1);
  const off = await run({
    ...approval,
    decision: 'withdraw-now',
    messageRef: 'wecom:customer:withdraw',
    instruction: 'Withdraw the authorized test article.',
  });
  assert.equal(off.state, 'withdrawn');
  await assert.rejects(run(), BlogToolError);
  assert.equal((await f.client.getPublication(first.operationId)).state, 'withdrawn');
});
test('a public-page failure keeps the committed publication receipt; retry checks the same article', async (t) => {
  const f = fixture(t);
  f.hide();
  await assert.rejects(
    publishKbDocument(f.client, binding, selected, approval, { request: f.request }),
    (e) =>
      e instanceof BlogToolError &&
      e.receipt?.state === 'published' &&
      e.receipt?.publicVerified === false,
  );
  assert.equal([...f.rows.keys()].filter((k) => k.startsWith('articleDrafts/')).length, 1);
});
test('source update stays on the same article; a human-edited draft is never replaced', async (t) => {
  const f = fixture(t);
  const first = await publishKbDocument(f.client, binding, selected, approval, {
    request: f.request,
  });
  const edited = { ...selected, article: { ...selected.article, title: 'Exact revised title' } };
  const next = await publishKbDocument(
    f.client,
    binding,
    edited,
    { ...approval, messageRef: 'wecom:customer:message-2' },
    { request: f.request },
  );
  assert.equal(next.articleId, first.articleId);
  assert.equal(next.revision, 2);
  const d = await f.repo.get({ actorId: 'admin', articleId: first.articleId });
  await f.repo.save({
    actorId: 'admin',
    articleId: d.id,
    expectedRevision: d.revision,
    content: { ...d.content, title: 'Human changes' },
  });
  await assert.rejects(
    publishKbDocument(
      f.client,
      binding,
      edited,
      { ...approval, messageRef: 'wecom:customer:message-3' },
      { request: f.request },
    ),
    /后台已经有人修改/,
  );
  assert.equal(
    (await f.repo.get({ actorId: 'admin', articleId: d.id })).content.title,
    'Human changes',
  );
});
