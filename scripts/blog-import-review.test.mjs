import assert from 'node:assert/strict';
import test from 'node:test';
import { IMPORT_ACCEPTANCE, ownedImportFixture } from './blog/import-review-policy.mjs';
import { identity } from './release/input.mjs';
const hash = identity;
function fixture() {
  const p = IMPORT_ACCEPTANCE;
  const operationId = `article-import-${hash(['supplychainsai.com', p.integrationId, p.draftKey])}`;
  const source = { externalTaskId: p.taskId, idempotencyKey: p.draftKey, body: 'test source' };
  const row = {
    _id: operationId,
    siteId: 'supplychainsai.com',
    integrationId: p.integrationId,
    importedRevision: 1,
    requestHash: hash(source),
    source,
    converterVersion: 'article-import-v1',
    articleId: operationId.replace('article-import-', 'article-'),
  };
  const draft = {
    id: row.articleId,
    createdBy: `integration:${p.integrationId}`,
    revision: 1,
    published: null,
    content: {
      title: 'Owned acceptance',
      slug: 'oem-brief-hermes-acceptance-20261026',
      authorName: 'Diversity Technology Limited',
      body: {},
    },
  };
  return { operationId, operation: 'review', row, draft };
}
test('live browser scope accepts the exact imported receipt and refuses foreign or changed content', () => {
  const f = fixture();
  assert.equal(ownedImportFixture(f).articleId, f.draft.id);
  for (const changed of [
    { ...f, operationId: `article-import-${'0'.repeat(64)}` },
    { ...f, row: { ...f.row, integrationId: 'other' } },
    { ...f, row: { ...f.row, requestHash: '0'.repeat(64) } },
    { ...f, draft: { ...f.draft, createdBy: 'admin:other' } },
    { ...f, draft: { ...f.draft, published: { revision: 1 } } },
    { ...f, draft: { ...f.draft, revision: 2 } },
    { ...f, operation: 'publish' },
    { ...f, operation: 'delete' },
  ])
    assert.throws(() => ownedImportFixture(changed));
});
test('publication requires the human review saved revision, not the model output alone', () => {
  const f = fixture();
  f.operation = 'publish';
  assert.throws(() => ownedImportFixture(f));
  f.draft.revision = 2;
  assert.throws(() => ownedImportFixture(f));
  f.draft.content.body = { text: IMPORT_ACCEPTANCE.marker };
  assert.equal(ownedImportFixture(f).revision, 2);
});

test('the manual imported-draft path keeps credentials in the needed steps and does not replace ordinary acceptance', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const workflow = parse(await readFile('.github/workflows/seo-blog-acceptance.yml', 'utf8'));
  const steps = workflow.jobs.browser.steps;
  const browser = steps.find((x) => x.run?.includes('blog-import-live.spec'));
  assert(browser.if.includes("startsWith(inputs.operation, 'import-')"));
  assert.equal(browser.env.TENCENTCLOUD_SECRETID, undefined);
  assert.equal(browser.env.TENCENTCLOUD_SECRETKEY, undefined);
  assert(browser.env.E2E_ADMIN_PASSWORD);
  assert(
    steps.some(
      (x) => x.run === 'node scripts/blog/acceptance-preflight.mjs' && x.if.includes('!startsWith'),
    ),
  );
  const parent = parse(await readFile('.github/workflows/seo-static-canary.yml', 'utf8'));
  for (const mode of ['blog-import-review', 'blog-import-publish', 'blog-import-withdraw'])
    assert(parent.on.workflow_dispatch.inputs.mode.options.includes(mode));
  assert.equal(parent.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(parent.concurrency['cancel-in-progress'], false);
});
