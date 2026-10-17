import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiError, listRecords } from './api.ts';
function storage(t: { after(fn: () => void): void }) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'owned-list-token' },
  });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
}
const valid = () => ({ items: [{ _id: 'p', name: 'Clock' }], total: 3, page: 2, pageSize: 1 });
test('list transport preserves scope and binds actual response page without changing records', async (t) => {
  storage(t);
  const args = { collection: 'products', page: 2, pageSize: 1 };
  const response = valid();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { action: 'list', data: args, token: 'owned-list-token' });
    return new Response(JSON.stringify({ ok: true, data: response }));
  });
  assert.deepEqual(await listRecords(args), response);
});
test('legitimate empty list remains a successful result', async (t) => {
  storage(t);
  const response = { items: [], total: 0, page: 1, pageSize: 20 };
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ ok: true, data: response })),
  );
  assert.deepEqual(await listRecords({ collection: 'products' }), response);
});
for (const response of [
  null,
  {},
  { ...valid(), items: null },
  { ...valid(), total: '3' },
  { ...valid(), total: -1 },
  { ...valid(), page: 1 },
  { ...valid(), pageSize: 20 },
  { ...valid(), items: [{ name: 'missing-id' }] },
  { ...valid(), items: [{ _id: 'p' }, { _id: 'p' }] },
  { ...valid(), items: [{ _id: 'a' }, { _id: 'b' }] },
])
  test(`malformed list success cannot become wrong rows or a false zero: ${JSON.stringify(response)}`, async (t) => {
    storage(t);
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ ok: true, data: response })),
    );
    await assert.rejects(
      listRecords({ collection: 'products', page: 2, pageSize: 1 }),
      (error) => error instanceof AdminApiError && error.code === 'INVALID_RESPONSE',
    );
  });

test('duplicate IDs are rejected even when they fit inside the requested page', async (t) => {
  storage(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: { items: [{ _id: 'p' }, { _id: 'p' }], total: 2, page: 1, pageSize: 20 },
        }),
      ),
  );
  await assert.rejects(
    listRecords({ collection: 'products' }),
    (error) => error instanceof AdminApiError && error.code === 'INVALID_RESPONSE',
  );
});
