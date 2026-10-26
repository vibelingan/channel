import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArticleDraft } from '../../packages/articles/src/draft-repository.ts';
import { importHash } from '../../packages/articles/src/import.ts';
import { parsePublishedArticle } from '../../packages/articles/src/publication.ts';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { IMPORT_ACCEPTANCE, ownedImportFixture } from './import-review-policy.mjs';
import { assertServerBlogReady } from './server-route-health.mjs';
import { blogWorkerSdk } from './worker-source.ts';
const env = process.env;
const policy = assertBlogBootstrapInvocation(env);
const operation = env.E2E_IMPORT_OPERATION;
assert(['review', 'publish', 'withdraw'].includes(operation ?? ''));
assert.equal(env.E2E_BLOG_DELIVERY_MODE, 'server');
function record(v: unknown): Record<string, unknown> {
  assert(v && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, unknown>;
}
const db = blogWorkerSdk({
  env: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID ?? '',
  secretKey: env.TENCENTCLOUD_SECRETKEY ?? '',
}).database();
async function row(collection: string, id: string) {
  return record(
    await db.runTransaction(
      async (tx: {
        collection(name: string): { doc(id: string): { get(): Promise<{ data: unknown }> } };
      }) => (await tx.collection(collection).doc(id).get()).data,
    ),
  );
}
const operationId = env.E2E_IMPORT_ID ?? '';
assert(/^article-import-[a-f0-9]{64}$/.test(operationId));
const imported = await row('articleImports', operationId);
assert.equal(imported.requestHash, importHash(imported.source));
const raw = await row('articleDrafts', String(imported.articleId));
const draft = parseArticleDraft(raw.draft);
const directory = 'output/blog-import';
await mkdir(directory, { recursive: true });
if (process.argv[2] === 'prepare') {
  assert(env.GITHUB_TOKEN);
  await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(env.GITHUB_SHA ?? '');
  const health = await assertServerBlogReady(policy.siteOrigin);
  await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(health.releaseId);
  const fixture = ownedImportFixture({ operationId, operation, row: imported, draft });
  await writeFile(`${directory}/fixture.json`, JSON.stringify(fixture, null, 2), { flag: 'wx' });
} else if (process.argv[2] === 'verify') {
  const fixture = record(JSON.parse(await readFile(`${directory}/fixture.json`, 'utf8')));
  assert.equal(fixture.articleId, draft.id);
  assert.equal(draft.createdBy, `integration:${IMPORT_ACCEPTANCE.integrationId}`);
  assert(JSON.stringify(draft.content.body).includes(IMPORT_ACCEPTANCE.marker));
  assert(draft.revision >= 2);
  const get = (path: string) =>
    fetchFully('GET', `${policy.siteOrigin}${path}`, {
      redirect: 'error',
      timeoutMs: 30000,
      maxBytes: 2 * 1024 * 1024,
    });
  const html = await get(`/blog/${draft.content.slug}/`);
  const list = await get('/blog/');
  const map = await get('/blog/sitemap.xml');
  assert.equal(list.status, 200);
  assert.equal(map.status, 200);
  const visible = operation === 'publish';
  assert.equal(html.status, visible ? 200 : 404);
  assert.equal(list.body.toString().includes(`/blog/${draft.content.slug}/`), visible);
  assert.equal(map.body.toString().includes(`/blog/${draft.content.slug}/`), visible);
  let taskId = null;
  if (operation !== 'review') {
    const head = await row('articleReleaseHeads', draft.id);
    const task = await row('articleReleaseTasks', String(head.taskId));
    assert.equal(task.articleId, draft.id);
    assert.equal(task.state, 'SUCCEEDED');
    assert.equal(task.receipt, null);
    assert.equal(task.workerId, null);
    taskId = task.id;
    const accepted = await row('articleAccepted', draft.id);
    if (visible) {
      const publication = parsePublishedArticle(accepted.publication);
      assert.equal(publication.revision, draft.revision);
      assert(html.body.toString().includes(IMPORT_ACCEPTANCE.marker));
      assert(
        html.body
          .toString()
          .includes(`rel="canonical" href="${policy.siteOrigin}/blog/${draft.content.slug}/"`),
      );
      assert(html.body.toString().includes('"@type":"Article"'));
    } else {
      assert.equal(accepted.publication, null);
      assert.equal(draft.published, null);
    }
  } else assert.equal(draft.published, null);
  await writeFile(
    `${directory}/proof.json`,
    JSON.stringify(
      {
        operation,
        operationId,
        articleId: draft.id,
        revision: draft.revision,
        taskId,
        htmlStatus: html.status,
        listStatus: list.status,
        sitemapStatus: map.status,
        visible,
        noContentBuild: true,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
} else throw Error('Explicit import acceptance stage required');
