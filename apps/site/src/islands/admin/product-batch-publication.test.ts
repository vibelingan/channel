import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { setAdapter } from '../../../../../packages/db/src/index.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../../../functions/admin/src/http-adapter.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';
import { batchUpdateRecords } from './api.ts';

test('browser bulk publication crosses the real HTTP handler, persists valid rows and keeps invalid drafts private', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-publish-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const db = new JsonFileAdapter(file);
  setAdapter(db);
  await db.create('users', {
    _id: 'operator',
    email: 'operator@local.invalid',
    role: 'admin',
    status: 'active',
  });
  await db.create('images', {
    _id: 'image',
    mimeType: 'image/png',
    data: 'iVBORw0KGgo=',
    publishedRefCount: 0,
  });
  const product = {
    published: false,
    name: 'Publish contract fixture',
    productFamily: 'headphones',
    description: 'A real local persistence check',
    imageIds: ['image'],
  };
  await db.create('products', { ...product, _id: 'ready' });
  await db.create('products', { ...product, _id: 'no-family', productFamily: null });
  await db.create('products', {
    ...product,
    _id: 'no-image',
    imageIds: [],
    alibabaSourceImageUrls: ['https://sc04.alicdn.com/preview.jpg'],
  });
  const config = {
    jwtSecret: 'publication-local-test-secret',
    loginUrl: 'http://localhost/login',
    resetPasswordUrl: 'http://localhost/reset',
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'operator',
    name: 'Operator',
    email: 'operator@local.invalid',
    role: 'admin',
  });
  const invoke = async (body: unknown) => {
    const response = await handleAdminFunctionEvent(
      { httpMethod: 'POST', body: JSON.stringify(body) },
      config,
      handleAdminRequest,
    );
    assert.ok('statusCode' in response);
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const old = await invoke({
    action: 'batchUpdate',
    token,
    data: { collection: 'products', ids: ['ready'], values: { published: true } },
  });
  assert.equal(old.status, 400);
  assert.match(await old.text(), /individually/);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    // Only bridge the network boundary. Production browser payload generation,
    // JWT verification, HTTP mapping, business validation and persistence are real.
    return invoke({ ...JSON.parse(String(init.body)), token });
  });
  const result = await batchUpdateRecords('products', ['ready', 'no-family', 'no-image'], {
    published: true,
  });
  assert.equal(result.updated, 1);
  assert.deepEqual(
    result.failures.map((row) => row.id),
    ['no-family', 'no-image'],
  );
  assert.match(result.failures[0]?.message ?? '', /family/i);
  assert.match(result.failures[1]?.message ?? '', /image/i);
  const reopened = new JsonFileAdapter(file);
  assert.equal((await reopened.get('products', 'ready'))?.published, true);
  assert.equal((await reopened.get('products', 'no-family'))?.published, false);
  assert.equal((await reopened.get('products', 'no-image'))?.published, false);
  assert.equal((await reopened.get('images', 'image'))?.publishedRefCount, 1);
  const disabled = await batchUpdateRecords('products', ['ready'], { published: false });
  assert.equal(disabled.updated, 1);
  assert.equal((await db.get('images', 'image'))?.publishedRefCount, 0);
  await db.update('users', 'operator', { status: 'suspended' });
  const revoked = await batchUpdateRecords('products', ['ready', 'no-family'], { published: true });
  assert.equal(revoked.updated, 0);
  assert.deepEqual(
    revoked.failures.map((row) => row.outcome),
    ['rejected', 'not-attempted'],
  );
});
