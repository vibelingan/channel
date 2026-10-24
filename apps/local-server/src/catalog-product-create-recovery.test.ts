import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '../../../packages/auth/src/jwt.ts';
import { setAdapter } from '../../../packages/db/src/index.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-create-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const db = new JsonFileAdapter(file);
  setAdapter(db);
  for (const id of ['first', 'second', 'contributor'])
    await db.create('users', {
      _id: id,
      role: id === 'contributor' ? 'contributor' : 'admin',
      status: 'active',
      email: `${id}@local.invalid`,
    });
  const jwtSecret = 'create-recovery-disposable-only';
  const invoke = async (data: unknown, actor = 'first') =>
    handleAdminRequest(
      {
        action: 'catalogProductCreate',
        token: await signSession(jwtSecret, {
          sub: actor,
          role: actor === 'contributor' ? 'contributor' : 'admin',
          name: actor,
          email: `${actor}@local.invalid`,
        }),
        data,
      },
      { jwtSecret, enableDetailApproval: true },
    );
  return { db, file, invoke };
}

const attemptId = '75b26848-514c-49a1-8475-30fd0d44debe';
const start = {
  action: 'start',
  attemptId,
  values: { name: 'Recoverable clock', published: false },
};

test('one original creation survives retry, concurrent submission and JSON reopen without changing fields', async (t) => {
  const h = await fixture(t);
  const replies = await Promise.all([h.invoke(start), h.invoke(start), h.invoke(start)]);
  for (const reply of replies) assert.ok(reply.ok, JSON.stringify(reply));
  const first = replies[0];
  assert.ok(first?.ok);
  const result = first.data as {
    productId: string;
    inputDigest: string;
    product: Record<string, unknown>;
  };
  assert.equal(
    new Set(replies.map((r) => r.ok && Reflect.get(r.data as object, 'productId'))).size,
    1,
  );
  const reopened = new JsonFileAdapter(h.file);
  assert.equal(
    (await reopened.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    1,
  );
  const row = await reopened.get('products', result.productId);
  assert.ok(row);
  assert.equal(row.published, false);
  assert.equal(Object.hasOwn(row, 'productFamily'), false);
  assert.equal(Object.hasOwn(result.product, 'catalogCreateReceipt'), false);
  await h.db.update('products', result.productId, { name: 'Later admin edit' });
  const before = await h.db.get('products', result.productId);
  const recovered = await h.invoke({ action: 'get', attemptId, inputDigest: result.inputDigest });
  assert.ok(recovered.ok, JSON.stringify(recovered));
  assert.equal(
    Reflect.get(Reflect.get(recovered.data as object, 'product'), 'name'),
    'Later admin edit',
  );
  assert.deepEqual(await h.db.get('products', result.productId), before);
});

test('a reused attempt cannot overwrite its input and another actor cannot recover its receipt', async (t) => {
  const h = await fixture(t);
  const created = await h.invoke(start);
  assert.ok(created.ok, JSON.stringify(created));
  const result = created.data as { productId: string; inputDigest: string };
  const before = await h.db.get('products', result.productId);
  for (const command of [
    { ...start, values: { ...start.values, name: 'Different input' } },
    { action: 'get', attemptId, inputDigest: '0'.repeat(64) },
  ]) {
    const rejected = await h.invoke(command);
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.code, 'CONFLICT');
  }
  const foreign = await h.invoke(
    { action: 'get', attemptId, inputDigest: result.inputDigest },
    'second',
  );
  assert.ok(!foreign.ok);
  assert.equal(foreign.error.code, 'NOT_FOUND');
  assert.deepEqual(await h.db.get('products', result.productId), before);
});

test('creation refuses publication and forged receipt while contributor draft permission remains', async (t) => {
  const h = await fixture(t);
  for (const values of [
    { name: 'Bad', published: true },
    { name: 'Bad', catalogCreateReceipt: {} },
  ]) {
    const result = await h.invoke({ ...start, values });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
  const contributor = await h.invoke(start, 'contributor');
  assert.ok(contributor.ok, JSON.stringify(contributor));
  assert.equal(Reflect.get(Reflect.get(contributor.data as object, 'product'), 'published'), false);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    1,
  );
});

test('replay preserves shared-photo counters and unique identities still reject a distinct creation', async (t) => {
  const h = await fixture(t);
  await h.db.create('images', {
    _id: 'photo',
    status: 'active',
    mimeType: 'image/png',
    publishedRefCount: 0,
  });
  const command = {
    ...start,
    values: { ...start.values, imageIds: ['photo'], skuCode: 'CLOCK-RECOVERY' },
  };
  const first = await h.invoke(command);
  assert.ok(first.ok, JSON.stringify(first));
  const image = await h.db.get('images', 'photo');
  assert.equal(image?.publishedRefCount, 0);
  const replay = await h.invoke(command);
  assert.deepEqual(replay, first);
  assert.deepEqual(await h.db.get('images', 'photo'), image);
  const duplicate = await h.invoke({
    ...command,
    attemptId: '01d6fdc6-1573-480d-866f-f37256b6dcae',
  });
  assert.ok(!duplicate.ok);
  assert.equal(duplicate.error.code, 'CONFLICT');
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    1,
  );
});
