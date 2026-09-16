import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { handleAdminRequest } from '@vibelingan-channel/fn-admin/handler';
import { CategoryApiResponseSchema } from '@vibelingan-channel/shared';
import { manageCatalogCategories } from '../../functions/admin/src/catalog-categories.ts';
import { saveCategoryMapping } from '../../functions/admin/src/catalog-categories.ts';
import { categoryAcceptanceFixture } from './category-acceptance-fixture.ts';
import { JsonFileAdapter } from './json-adapter.ts';

test('bounded classification action survives restart and concurrent retries without publishing or touching deferred products', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-categories-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const db = new JsonFileAdapter(file);
  setAdapter(db);
  await db.create('users', { _id: 'admin', role: 'admin' });
  for (const [id, category] of [
    ['clock', '152801'],
    ['deferred', '100007155'],
  ]) {
    await db.create('products', {
      _id: id,
      name: id,
      published: false,
      alibabaPrimarySourceKey: `s-${id}`,
      alibabaSourceCategoryId: category,
    });
    await db.create('alibabaSourceProducts', {
      _id: `s-${id}`,
      sourceCategoryId: category,
      active: true,
    });
    await db.create('alibabaProductLinks', { _id: `s-${id}`, productId: id });
  }
  const before = await db.get('products', 'deferred');
  for (let offset: number | null = 0; offset !== null; ) {
    const page = await manageCatalogCategories('admin', { kind: 'configure', offset });
    assert.equal(page.kind, 'configure');
    assert.ok(page.results.every((row) => row.status === 'configured'));
    offset = page.nextOffset;
  }
  const page = await manageCatalogCategories('admin', { kind: 'preview' });
  assert.equal(page.kind, 'preview');
  const row = page.rows.find((row) => row.productId === 'clock');
  assert.ok(row?.command);
  const input = { kind: 'apply', commands: [{ ...row.command, operationId: randomUUID() }] };
  const results = await Promise.all([
    manageCatalogCategories('admin', input),
    manageCatalogCategories('admin', input),
  ]);
  assert.deepEqual(
    results
      .map((result) => {
        assert.equal(result.kind, 'apply');
        return result.results[0]?.status;
      })
      .sort(),
    ['applied', 'replayed'],
  );
  const reopened = new JsonFileAdapter(file);
  setAdapter(reopened);
  assert.equal((await reopened.get('products', 'clock'))?.productFamily, 'misc');
  assert.equal((await reopened.get('products', 'clock'))?.published, false);
  assert.deepEqual(await reopened.get('products', 'deferred'), before);
  const repeat = await manageCatalogCategories('admin', input);
  assert.equal(repeat.kind, 'apply');
  assert.equal(repeat.results[0]?.status, 'replayed');
  const now = new Date().toISOString();
  const lease = await reopened.acquireAlibabaSyncLease('category-test', 'worker', now, 60000);
  assert.equal(lease.result, 'granted');
  assert.equal(
    await reopened.updateDocWithAlibabaLease(
      'products',
      'clock',
      { alibabaSourceCategoryId: '518' },
      { connectionId: 'category-test', holder: 'worker', fence: lease.fence, now },
    ),
    true,
  );
  const moved = await reopened.get('products', 'clock');
  assert.equal(moved?.productFamily, 'misc');
  assert.equal(moved?.alibabaClassifiedCategoryId, '152801');
  const publish = await reopened.saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'clock',
    data: { published: true, name: 'Clock', description: 'Description', imageIds: ['image'] },
  });
  assert.equal(publish.result, 'invalid-product');
  const confirm = await reopened.saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'clock',
    data: { productFamily: 'misc' },
  });
  assert.equal(confirm.result, 'saved');
  assert.equal((await reopened.get('products', 'clock'))?.alibabaClassifiedCategoryId, '518');
  assert.equal((await reopened.get('products', 'clock'))?.published, false);
  await assert.rejects(() =>
    manageCatalogCategories('admin', {
      kind: 'apply',
      commands: [{ ...row.command, operationId: randomUUID(), productFamily: 'toys' }],
    }),
  );
});

test('dated audit fixture: real admin handler paginates 1081 rows, assigns 302, leaves 56 and 723 existing rows unchanged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-category-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const db = new JsonFileAdapter(file);
  setAdapter(db);
  const fixture = categoryAcceptanceFixture();
  for (const [collection, rows] of Object.entries(fixture)) db.seedIfEmpty(collection, rows);
  const originalRows = (
    await db.list({ collection: 'products', page: 1, pageSize: 2000, search: '' })
  ).items;
  await db.create('users', {
    _id: 'admin',
    username: 'admin',
    email: 'admin@local.invalid',
    role: 'admin',
    status: 'active',
  });
  const config = {
    jwtSecret: 'category-test-secret',
    loginUrl: 'http://localhost/login',
    resetPasswordUrl: 'http://localhost/reset',
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    name: 'admin',
    email: 'admin@local.invalid',
    role: 'admin',
  });
  async function call(data: unknown) {
    const response = await handleAdminRequest({ action: 'catalogCategories', token, data }, config);
    assert.equal(response.ok, true);
    return CategoryApiResponseSchema.parse(response.data);
  }
  const denied = await handleAdminRequest(
    { action: 'catalogCategories', data: { kind: 'configure' } },
    config,
  );
  assert.equal(denied.ok, false);
  for (let offset: number | null = 0; offset !== null; ) {
    const r = await call({ kind: 'configure', offset });
    assert.equal(r.kind, 'configure');
    assert.ok(r.results.every((row) => row.status === 'configured'));
    offset = r.nextOffset;
  }
  let after: string | undefined;
  const rows = [];
  do {
    const r = await call({ kind: 'preview', ...(after ? { after } : {}) });
    assert.equal(r.kind, 'preview');
    rows.push(...r.rows);
    after = r.nextAfter ?? undefined;
  } while (after);
  assert.equal(rows.length, 1081);
  assert.equal(new Set(rows.map((row) => row.productId)).size, 1081);
  const ready = rows.filter((row) => row.status === 'ready');
  assert.equal(ready.length, 302);
  assert.deepEqual(
    ['misc', 'ai-gadgets', 'toys'].map(
      (family) => ready.filter((row) => row.target === family).length,
    ),
    [291, 5, 6],
  );
  assert.equal(rows.filter((row) => row.status === 'deferred').length, 56);
  for (let offset = 0; offset < ready.length; offset += 10) {
    const r = await call({
      kind: 'apply',
      commands: ready
        .slice(offset, offset + 10)
        .map((row) => ({ ...row.command, operationId: randomUUID() })),
    });
    assert.equal(r.kind, 'apply');
    assert.ok(r.results.every((row) => row.status === 'applied'));
  }
  const reopened = new JsonFileAdapter(file);
  setAdapter(reopened);
  for (const row of rows) {
    const actual = await reopened.get('products', row.productId);
    assert.ok(actual);
    const before = originalRows.find((product) => product._id === row.productId);
    assert.ok(before);
    if (row.status === 'ready') {
      assert.equal(actual.productFamily, row.target);
      assert.equal(actual.published, false);
    } else assert.deepEqual(actual, before);
  }
  await assert.rejects(
    () =>
      saveCategoryMapping({
        provider: 'alibaba',
        sourceTaxonomy: 'alibaba:icbu',
        sourceCategoryId: '152801',
        productFamily: 'toys',
      }),
    /already exists/,
  );
  await assert.rejects(
    () => saveCategoryMapping({ sourceCategoryId: '518' }, 'alibaba-icbu-152801'),
    /identity cannot/,
  );
  await assert.rejects(
    () => saveCategoryMapping({ reviewRequired: false }, 'alibaba-icbu-100001765'),
    /Choose a website/,
  );
  const malformed = await handleAdminRequest(
    { action: 'catalogCategories', token, data: { kind: 'apply', commands: [] } },
    config,
  );
  assert.equal(malformed.ok, false);
});
