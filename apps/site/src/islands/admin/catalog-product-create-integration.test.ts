import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { setAdapter } from '../../../../../packages/db/src/index.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';
import { createRecord } from './api.ts';
import {
  ProductCreationUnknownError,
  captureProductCreation,
  startProductCreation,
} from './catalog-product-create-api.ts';
import { createProductCreationController } from './catalog-product-creation.ts';

async function fixture(t: test.TestContext, lose: 'start' | 'both' | 'before' | 'none' = 'none') {
  const dir = mkdtempSync(join(tmpdir(), 'channel-create-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new JsonFileAdapter(join(dir, 'db.json'));
  setAdapter(db);
  for (const id of ['first', 'second'])
    await db.create('users', {
      _id: id,
      role: 'admin',
      status: 'active',
      email: `${id}@local.invalid`,
    });
  let session = {
    actorId: 'first',
    token: 'bound-token',
    endpoint: 'https://local.invalid/api/admin',
  };
  let failure = lose;
  const calls: Array<{ action: string; data: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (failure === 'before' && body.data.action === 'start') {
      failure = 'none';
      throw Error('request disconnected before reaching the handler');
    }
    const result = await handleAdminRequest(
      {
        ...body,
        token: await signSession('create-client-secret', {
          sub: session.actorId,
          role: 'admin',
          name: 'Operator',
          email: `${session.actorId}@local.invalid`,
        }),
      },
      { jwtSecret: 'create-client-secret', enableDetailApproval: true },
    );
    if (failure === 'both' || (failure === 'start' && body.data.action === 'start')) {
      if (failure === 'start') failure = 'none';
      throw Error('committed response lost');
    }
    return Response.json(result);
  });
  const entries = new Map<string, string>();
  const storage = {
    get length() {
      return entries.size;
    },
    key: (i: number) => [...entries.keys()][i] ?? null,
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => {
      entries.set(k, v);
    },
    removeItem: (k: string) => {
      entries.delete(k);
    },
  };
  const controller = () =>
    createProductCreationController({ storage: () => storage, session: () => session });
  return {
    db,
    calls,
    entries,
    storage,
    controller,
    recover: () => {
      failure = 'none';
    },
    switchActor: () => {
      session = { ...session, actorId: 'second', token: 'second-token' };
    },
  };
}

test('the real client recovers a lost committed create response with one original lookup and no duplicate', async (t) => {
  const h = await fixture(t, 'start');
  const draft = await createRecord('products', { name: 'Clock', published: false });
  assert.equal(draft.published, false);
  assert.deepEqual(
    h.calls.map((c) => c.data.action),
    ['start', 'get'],
  );
  assert.equal(new Set(h.calls.map((c) => c.data.attemptId)).size, 1);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    1,
  );
});

test('two lost responses keep a pointer across form reload and recovery is readonly and keeps later edits', async (t) => {
  const h = await fixture(t, 'both');
  const first = h.controller();
  await assert.rejects(
    first.save({ name: 'Clock', published: false }),
    ProductCreationUnknownError,
  );
  const selected = first.pending().entries[0];
  assert.ok(selected);
  assert.equal(h.entries.size, 1);
  assert.equal(JSON.stringify([...h.entries]).includes('Clock'), false);
  const rows = await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' });
  assert.equal(rows.total, 1);
  const row = rows.items[0];
  assert.ok(row);
  const id = row._id;
  await h.db.update('products', id, { name: 'A later edit', category: 'legacy-value' });
  const before = await h.db.get('products', id);
  h.recover();
  const next = h.controller();
  const reloaded = next.pending().entries[0];
  assert.ok(reloaded);
  const recovered = await next.check(reloaded);
  assert.equal(recovered._id, id);
  assert.equal(recovered.name, 'A later edit');
  assert.deepEqual(await h.db.get('products', id), before);
  assert.equal(h.calls.filter((c) => c.data.action === 'start').length, 1);
  assert.equal(h.entries.size, 0);
});

test('an uncertain creation cannot become a new attempt when the user edits or switches account', async (t) => {
  const h = await fixture(t, 'both');
  const control = h.controller();
  await assert.rejects(
    control.save({ name: 'Clock', published: false }),
    ProductCreationUnknownError,
  );
  const count = h.calls.length;
  await assert.rejects(
    control.save({ name: 'Changed text', published: false }),
    /original creation/,
  );
  assert.equal(h.calls.length, count);
  const selected = control.pending().entries[0];
  assert.ok(selected);
  h.switchActor();
  assert.throws(() => control.pending(), /original account/);
  await assert.rejects(control.check(selected), /original account/);
  assert.equal(h.calls.length, count);
  assert.equal(h.entries.size, 1);
  assert.deepEqual(h.controller().pending().entries, []);
});

test('unavailable recovery storage blocks creation before any write', async (t) => {
  const h = await fixture(t);
  const control = createProductCreationController({
    session: () => ({ actorId: 'first', token: 'x', endpoint: 'https://local.invalid/api/admin' }),
    storage: () => {
      throw Error('storage blocked');
    },
  });
  await assert.rejects(control.save({ name: 'Clock', published: false }), /browser storage/);
  assert.deepEqual(h.calls, []);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    0,
  );
});

test('captured input is frozen and another intentional creation remains a distinct product', async (t) => {
  const h = await fixture(t);
  const values = { name: 'Clock', published: false, imageIds: [] as string[] };
  const first = await captureProductCreation(values);
  values.name = 'Edited outside the attempt';
  assert.equal(first.values.name, 'Clock');
  assert.throws(() => {
    (first.values.imageIds as string[]).push('other');
  });
  const a = await startProductCreation(first);
  const b = await startProductCreation(
    await captureProductCreation({ name: 'Clock', published: false, imageIds: [] }),
  );
  assert.notEqual(a.productId, b.productId);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    2,
  );
});

test('recovering a changed created product never applies the old publication intent or labels it unpublished', async (t) => {
  const h = await fixture(t);
  await h.db.create('images', {
    _id: 'owned',
    status: 'active',
    mimeType: 'image/png',
    publishedRefCount: 0,
  });
  const values = { name: 'Clock', productFamily: 'misc', imageIds: ['owned'], published: true };
  const attempt = await captureProductCreation({ ...values, published: false });
  const created = await startProductCreation(attempt);
  await h.db.update('products', created.productId, {
    name: 'Another admin changed this product',
    archived: true,
    published: false,
  });
  const before = await h.db.get('products', created.productId);
  await assert.rejects(createRecord('products', values, attempt), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, 'CREATION_CHANGED');
    assert.doesNotMatch(error.message, /not published|saved as a draft/i);
    return true;
  });
  assert.deepEqual(await h.db.get('products', created.productId), before);
  assert.equal(
    h.calls.every((call) => call.action === 'catalogProductCreate'),
    true,
  );
});

test('concurrent original creates sharing photos recover through bounded BUSY retries without counter drift', async (t) => {
  const h = await fixture(t);
  await h.db.create('images', {
    _id: 'owned',
    status: 'active',
    mimeType: 'image/png',
    publishedRefCount: 0,
  });
  const values = { name: 'Shared photo clock', imageIds: ['owned'], published: false };
  const attempt = await captureProductCreation(values);
  const replies = await Promise.all([
    createRecord('products', values, attempt),
    createRecord('products', values, attempt),
  ]);
  const [first, second] = replies;
  assert.ok(first && second);
  assert.equal(first._id, second._id);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    1,
  );
  assert.equal((await h.db.get('images', 'owned'))?.publishedRefCount, 0);
  assert.equal(new Set(h.calls.map((call) => call.data.attemptId)).size, 1);
});

test('an unrelated create receipt is queried again and never substitutes for the original attempt', async (t) => {
  await fixture(t);
  const attempt = await captureProductCreation({ name: 'Original clock', published: false });
  const original = await startProductCreation(attempt);
  const calls: string[] = [];
  const recovered = await startProductCreation(attempt, async (command) => {
    calls.push(command.action);
    return command.action === 'start'
      ? { ...original, attemptId: '84572ee4-74d7-45cd-a97d-fca516a3aaed' }
      : original;
  });
  assert.deepEqual(recovered, original);
  assert.deepEqual(calls, ['start', 'get']);
});

test('the existing New Product archived option still creates one private archived product', async (t) => {
  const h = await fixture(t);
  const product = await createRecord('products', {
    name: 'Created in archive',
    published: false,
    archived: true,
  });
  assert.equal(product.archived, true);
  assert.equal(product.published, false);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    1,
  );
});

test('conflicting archive and publish choices are refused before creating any product', async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    createRecord('products', { name: 'Conflicting lifecycle', archived: true, published: true }),
    /archived product cannot be published/,
  );
  assert.deepEqual(h.calls, []);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    0,
  );
});

test('an unconfirmed request that never reached the server retries only its same captured creation', async (t) => {
  const h = await fixture(t, 'before');
  const control = h.controller();
  const values = { name: 'Never dispatched clock', published: false };
  await assert.rejects(control.save(values), ProductCreationUnknownError);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    0,
  );
  const saved = await control.save(values);
  assert.equal(saved.name, values.name);
  assert.equal(
    (await h.db.list({ collection: 'products', page: 1, pageSize: 20, search: '' })).total,
    1,
  );
  assert.equal(new Set(h.calls.map((call) => call.data.attemptId)).size, 1);
  assert.equal(h.entries.size, 0);
});
