import assert from 'node:assert/strict';
import test from 'node:test';
import { ArticleImportError } from '@vibelingan-channel/articles/import';
import { handleArticleImportEvent } from './http-adapter.ts';
const root = '/api/integrations/v1/article-drafts';
const credentials = `content.${'f'.repeat(64)}`;
const receipt = {
  operationId: `article-import-${'a'.repeat(64)}`,
  articleId: `article-${'a'.repeat(64)}`,
  state: 'ready' as const,
  importedRevision: 1 as const,
  createdAt: '2026-10-26T00:00:00.000Z',
  editUrl: `https://supplychainsai.com/admin/?section=articles&article=article-${'a'.repeat(64)}`,
  operationUrl: `${root}/article-import-${'a'.repeat(64)}`,
  replayed: false,
};
function fixture() {
  const calls: unknown[] = [];
  return {
    calls,
    service: {
      create: async (credential: string, input: unknown) => {
        calls.push([credential, input]);
        return receipt;
      },
      get: async (credential: string, id: string) => {
        calls.push([credential, id]);
        return { ...receipt, replayed: true };
      },
    },
  };
}
const request = {
  httpMethod: 'POST',
  path: root,
  headers: { authorization: `Bearer ${credentials}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Draft' }),
};
test('only the fixed integration routes accept server credentials; browser actions and other methods are rejected', async () => {
  const f = fixture();
  const result = await handleArticleImportEvent(request, f.service);
  assert.equal(result.statusCode, 201);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(
    (
      await handleArticleImportEvent(
        { ...request, path: `${root}/${receipt.operationId}`, httpMethod: 'GET', body: '' },
        f.service,
      )
    ).statusCode,
    200,
  );
  for (const change of [
    { path: '/api/admin' },
    { httpMethod: 'DELETE' },
    { path: `${root}/extra/path` },
    { headers: { 'content-type': 'application/json' } },
  ])
    assert.notEqual(
      (await handleArticleImportEvent({ ...request, ...change }, f.service)).statusCode,
      201,
    );
  assert.equal(f.calls.length, 2);
});
test('base64, UTF-8, JSON and total byte boundaries cannot bypass parsing', async () => {
  const f = fixture();
  assert.equal(
    (
      await handleArticleImportEvent(
        { ...request, isBase64Encoded: true, body: Buffer.from(request.body).toString('base64') },
        f.service,
      )
    ).statusCode,
    201,
  );
  for (const body of ['@@@', Buffer.from([0xff]).toString('base64')])
    assert.equal(
      (await handleArticleImportEvent({ ...request, isBase64Encoded: true, body }, f.service))
        .statusCode,
      400,
    );
  assert.equal(
    (await handleArticleImportEvent({ ...request, body: ' '.repeat(256 * 1024 + 1) }, f.service))
      .statusCode,
    413,
  );
  assert.equal(
    (await handleArticleImportEvent({ ...request, body: 'not JSON' }, f.service)).statusCode,
    400,
  );
});
test('quota errors carry Retry-After while storage errors never reveal SDK details', async () => {
  const f = fixture();
  f.service.create = async () => {
    throw new ArticleImportError('RATE_LIMITED', 'Draft creation limit reached.', 42);
  };
  const limited = await handleArticleImportEvent(request, f.service);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '42');
  f.service.create = async () => {
    throw new Error('PRIVATE_DATABASE_DETAIL');
  };
  const failed = await handleArticleImportEvent(request, f.service);
  assert.equal(failed.statusCode, 503);
  assert(!failed.body.includes('PRIVATE_DATABASE_DETAIL'));
  assert.equal((await handleArticleImportEvent(request, undefined)).statusCode, 503);
});
