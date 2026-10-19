import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { workspace } from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { AdminApiError } from './api.ts';
import { type DraftSaveResult, createDraftSaveController } from './catalog-draft-save.ts';

async function fixture(t: TestContext) {
  const h = await workspace(t);
  const token = await signSession('owned-continue-test-only', {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const values = new Map<string, string>([
    ['channel.token', token],
    ['channel.user', JSON.stringify({ id: 'admin', role: 'admin' })],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (n: number) => [...values.keys()][n] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
  for (const [name, value] of [
    ['localStorage', storage],
    ['location', new URL('https://draft.test/admin')],
  ] as const) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const calls: { action: string; token?: string; data?: Record<string, unknown> }[] = [];
  let fault: 'none' | 'start-before' | 'save-after' | 'save-and-check' = 'none';
  let saveDropped = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(structuredClone(body));
      if (fault === 'start-before' && body.data?.action === 'product-operation-start')
        throw Error('start never reached server');
      if (
        fault === 'save-and-check' &&
        saveDropped &&
        body.data?.action === 'product-operation-get'
      )
        throw Error('receipt read unavailable');
      const result = await handleAdminRequest(body, {
        jwtSecret: 'owned-continue-test-only',
        enableDetailApproval: true,
      });
      if (
        ['save-after', 'save-and-check'].includes(fault) &&
        !saveDropped &&
        result.ok &&
        body.data?.action === 'product-operation-save'
      ) {
        saveDropped = true;
        throw Error('save committed, reply lost');
      }
      return Response.json(result);
    },
  );
  const opened = await h.adapter.get('products', h.productId);
  assert.ok(opened);
  return {
    ...h,
    opened,
    storage,
    values,
    calls,
    fault: (value: typeof fault) => {
      fault = value;
    },
  };
}

for (const fault of ['none', 'save-after', 'save-and-check'] as const)
  test(`draft save confirms its original receipt without replaying a committed write: ${fault}`, async (t) => {
    const h = await fixture(t);
    h.fault(fault);
    const control = createDraftSaveController(h.productId);
    const input = {
      description: 'Private edited description',
      published: false,
      imageIds: ['image'],
    };
    let result: DraftSaveResult;
    if (fault === 'save-and-check') {
      await assert.rejects(control.save(h.opened, input));
      assert.equal(control.pending().entries.length, 1);
      h.fault('none');
      const reopened = createDraftSaveController(h.productId);
      result = await reopened.check(reopened.pending().entries[0].scope);
      assert.equal(result.state, 'saved');
      assert.equal(reopened.acknowledge(result.scope).entries.length, 0);
    } else {
      result = await control.save(h.opened, input);
      assert.equal(result.state, 'saved');
      assert.equal(control.pending().entries.length, 1);
      control.acknowledge(result.scope);
    }
    assert.equal(h.calls.filter((c) => c.data?.action === 'product-operation-save').length, 1);
    assert.equal(h.calls.filter((c) => c.data?.action === 'product-operation-start').length, 1);
    const saved = await h.adapter.get('products', h.productId);
    assert.equal(saved?.description, input.description);
    assert.equal(saved?.published, false);
    assert.equal(saved?.productFamily, h.opened.productFamily);
    assert.deepEqual(saved?.manualCatalogPricing, h.opened.manualCatalogPricing);
    assert.deepEqual(saved?.imageIds, h.opened.imageIds);
    const pointers = [...h.values].filter(([key]) => key.startsWith('channel:draft:'));
    assert.doesNotMatch(JSON.stringify(pointers), /Private edited description/);
    assert.equal(
      h.calls.some((c) => c.action === 'update'),
      false,
    );
  });

test('unarrived save can only resume the same captured input, and reload can stop it without a body', async (t) => {
  const h = await fixture(t);
  h.fault('start-before');
  const control = createDraftSaveController(h.productId);
  const input = { description: 'Frozen private input', imageIds: ['image'] };
  const pendingSave = control.save(h.opened, input);
  input.description = 'Later unsaved edit';
  input.imageIds.push('new-photo');
  await assert.rejects(pendingSave);
  const pointer = control.pending().entries[0];
  assert.ok(pointer);
  assert.equal(pointer.scope.inputDigest, undefined);
  await assert.rejects(
    control.save(h.opened, { description: 'Different input' }),
    (e) => e instanceof AdminApiError && e.code === 'SAVE_PENDING',
  );
  const reopened = createDraftSaveController(h.productId);
  h.fault('none');
  await assert.rejects(
    reopened.resume(pointer.scope),
    (e) => e instanceof AdminApiError && e.code === 'SAVE_INPUT_MISSING',
  );
  const stopped = await reopened.stop(pointer.scope);
  assert.equal(stopped.state, 'cancelled');
  assert.deepEqual(await h.adapter.get('products', h.productId), h.opened);
  reopened.acknowledge(stopped.scope);
  assert.equal(reopened.pending().entries.length, 0);
  const late = h.calls.find((c) => c.data?.action === 'product-operation-start');
  assert.ok(late);
  const response = await handleAdminRequest(late, {
    jwtSecret: 'owned-continue-test-only',
    enableDetailApproval: true,
  });
  assert.equal(response.ok, false);
  assert.deepEqual(await h.adapter.get('products', h.productId), h.opened);
});

test('same-page explicit resume preserves the frozen patch and nonce', async (t) => {
  const h = await fixture(t);
  h.fault('start-before');
  const control = createDraftSaveController(h.productId);
  const input = { description: 'Frozen private input', imageIds: ['image'] };
  const pending = control.save(h.opened, input);
  input.description = 'Do not silently submit this';
  input.imageIds.push('unprepared');
  await assert.rejects(pending);
  const selected = control.pending().entries[0].scope;
  h.fault('none');
  const saved = await control.resume(selected);
  assert.equal(saved.state, 'saved');
  assert.equal((await h.adapter.get('products', h.productId))?.description, 'Frozen private input');
  const starts = h.calls.filter((c) => c.data?.action === 'product-operation-start');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].data, starts[1].data);
});

test('historical saved receipt cannot replace a later edit or be mistaken for the current draft', async (t) => {
  const h = await fixture(t);
  const control = createDraftSaveController(h.productId);
  const result = await control.save(h.opened, { description: 'Saved once' });
  assert.equal(result.state, 'saved');
  await h.adapter.update('products', h.productId, { description: 'Edited in another tab' });
  const before = h.bytes();
  const checked = await control.resume(result.scope);
  assert.equal(checked.state, 'historical');
  assert.equal(checked.product?.description, 'Edited in another tab');
  assert.equal(h.bytes(), before);
  assert.equal(h.calls.filter((c) => c.data?.action === 'product-operation-save').length, 1);
});

test('closing a confirmed save can be retried after browser storage refuses removal', async (t) => {
  const h = await fixture(t);
  const control = createDraftSaveController(h.productId);
  const result = await control.save(h.opened, { description: 'Saved once' });
  const remove = h.storage.removeItem;
  h.storage.removeItem = () => {
    throw Error('storage unavailable');
  };
  assert.equal(control.acknowledge(result.scope).entries.length, 1);
  h.storage.removeItem = remove;
  assert.equal(control.acknowledge(result.scope).entries.length, 0);
  assert.equal(h.calls.filter((c) => c.data?.action === 'product-operation-save').length, 1);
});

test('an account switch prevents the old form from sending any more save or recovery requests', async (t) => {
  const h = await fixture(t);
  h.fault('start-before');
  const control = createDraftSaveController(h.productId);
  await assert.rejects(control.save(h.opened, { description: 'Original private edit' }));
  const scope = control.pending().entries[0].scope;
  h.values.set('channel.user', JSON.stringify({ id: 'other', role: 'admin' }));
  const count = h.calls.length;
  for (const action of ['check', 'resume', 'stop'] as const)
    await assert.rejects(
      control[action](scope),
      (e) => e instanceof AdminApiError && e.code === 'SESSION_CHANGED',
    );
  assert.equal(h.calls.length, count);
  assert.deepEqual(await h.adapter.get('products', h.productId), h.opened);
});

test('unavailable durable storage blocks the first save write and leaves an exportable pointer', async (t) => {
  const h = await fixture(t);
  h.storage.setItem = () => {
    throw Error('quota exceeded');
  };
  const control = createDraftSaveController(h.productId);
  await assert.rejects(
    control.save(h.opened, { description: 'Retain form locally' }),
    (e) => e instanceof AdminApiError && e.code === 'STORAGE_UNAVAILABLE',
  );
  assert.equal(h.calls.filter((c) => c.action === 'catalogDetailApproval').length, 0);
  assert.equal(control.pending().entries.length, 1);
  assert.doesNotMatch(control.export(), /Retain form locally/);
  assert.deepEqual(await h.adapter.get('products', h.productId), h.opened);
});

test('a bound original receipt later missing cannot be replaced by a stop tombstone', async (t) => {
  const h = await fixture(t);
  const control = createDraftSaveController(h.productId);
  const result = await control.save(h.opened, { description: 'Previously saved' });
  const rows = JSON.parse(h.bytes());
  assert.equal(rows.catalogDetailApprovals.length, 1);
  assert.equal(rows.catalogDetailApprovals[0].operationId, result.scope.operationId);
  rows.catalogDetailApprovals = [];
  writeFileSync(h.file, JSON.stringify(rows));
  const before = h.bytes();
  for (const action of ['resume', 'stop'] as const)
    await assert.rejects(
      control[action](result.scope),
      (e) => e instanceof AdminApiError && e.code === 'NOT_FOUND',
    );
  assert.equal(h.bytes(), before);
  assert.equal(control.pending().entries.length, 1);
  assert.equal(h.calls.filter((c) => c.data?.action === 'product-operation-stop').length, 0);
});

test('double Save has one original start and one product write', async (t) => {
  const h = await fixture(t);
  const control = createDraftSaveController(h.productId);
  const first = control.save(h.opened, { description: 'First click' });
  await assert.rejects(
    control.save(h.opened, { description: 'Second click' }),
    (e) => e instanceof AdminApiError && e.code === 'BUSY',
  );
  assert.equal((await first).state, 'saved');
  assert.equal((await h.adapter.get('products', h.productId))?.description, 'First click');
  assert.equal(h.calls.filter((c) => c.data?.action === 'product-operation-start').length, 1);
  assert.equal(h.calls.filter((c) => c.data?.action === 'product-operation-save').length, 1);
});
