import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBlogToolClient, readBlogToolConfig } from './client.mjs';
const config = {
  apiOrigin: 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com',
  siteOrigin: 'https://supplychainsai.com',
  credential: `key.${'f'.repeat(64)}`,
  integrationId: 'hermes-local',
};
const input = {
  idempotencyKey: 'task-1',
  externalTaskId: 'task-1',
  format: 'markdown',
  title: 'Draft',
  body: 'Text',
};
const digest = createHash('sha256')
  .update(JSON.stringify(['supplychainsai.com', config.integrationId, input.idempotencyKey]))
  .digest('hex');
const receipt = {
  operationId: `article-import-${digest}`,
  articleId: `article-${digest}`,
  state: 'ready',
  importedRevision: 1,
  createdAt: '2026-10-26T00:00:00.000Z',
  editUrl: `${config.siteOrigin}/admin/?section=articles&article=article-${digest}`,
  operationUrl: `/api/integrations/v1/article-drafts/article-import-${digest}`,
  replayed: false,
};
const success = (data = receipt) => ({
  status: 201,
  body: Buffer.from(JSON.stringify({ ok: true, data })),
});
test('a transient failure retries the identical body and key, without redirects or caller-selected destinations', async () => {
  const calls = [];
  const client = createBlogToolClient(config, {
    pause: async () => {},
    request: async (...args) => {
      calls.push(args);
      return calls.length === 1 ? { status: 503, body: Buffer.from('{}') } : success();
    },
  });
  assert.equal((await client.createDraft(input)).articleId, receipt.articleId);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0][2].redirect, 'error');
  assert(!calls[0][1].includes(config.credential));
  assert.throws(() => createBlogToolClient({ ...config, apiOrigin: 'https://evil.example' }));
  assert.throws(() => readBlogToolConfig({}));
});
test('invalid replies never become editable draft links; permanent failures are not retried', async () => {
  for (const data of [
    { ...receipt, editUrl: 'https://evil.example/admin' },
    { ...receipt, operationId: `article-import-${'a'.repeat(64)}` },
    { ...receipt, articleId: `article-${'b'.repeat(64)}` },
  ])
    await assert.rejects(
      createBlogToolClient(config, { request: async () => success(data) }).createDraft(input),
      /尚不能提供编辑链接/,
    );
  let count = 0;
  await assert.rejects(
    createBlogToolClient(config, {
      request: async () => {
        count++;
        return { status: 409, body: Buffer.from('{}') };
      },
    }).createDraft(input),
    /HTTP 409/,
  );
  assert.equal(count, 1);
});
test('an isolated content task cannot create a second draft by changing its key', async () => {
  let count = 0;
  const client = createBlogToolClient(
    { ...config, taskId: input.externalTaskId, draftKey: input.idempotencyKey },
    {
      request: async () => {
        count++;
        return success();
      },
    },
  );
  await assert.rejects(client.createDraft({ ...input, idempotencyKey: 'new-key' }), /编号已固定/);
  assert.equal(count, 0);
  assert.equal((await client.createDraft(input)).articleId, receipt.articleId);
});
