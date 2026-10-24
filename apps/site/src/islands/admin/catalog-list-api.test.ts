import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiError, getRecord, listRecords } from './api.ts';
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

test('getRecord forwards cancellation to its HTTP read', async (t) => {
  storage(t);
  const controller = new AbortController();
  const reason = new DOMException('Owned cancelled product read', 'AbortError');
  controller.abort(reason);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.signal?.aborted, true);
    throw init.signal?.reason;
  });
  await assert.rejects(
    getRecord('products', 'owned-product', controller.signal),
    (error) => error === reason,
  );
});

const listView = 'admin-product-list-v1' as const;
const listMarker = '_adminProductListView';
test('product list validates requested summary protocol including empty pages', async (t) => {
  storage(t);
  for (const items of [[], [{ _id: 'p', [listMarker]: listView }]]) {
    const response = {
      items,
      total: items.length,
      page: 1,
      pageSize: 20,
      catalogListView: listView,
    };
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.equal(JSON.parse(String(init.body)).data.catalogListView, listView);
      return new Response(JSON.stringify({ ok: true, data: response }));
    });
    assert.deepEqual(
      await listRecords({ collection: 'products', catalogListView: listView }),
      response,
    );
  }
});
for (const response of [
  { items: [], total: 0, page: 1, pageSize: 20 },
  { items: [], total: 0, page: 1, pageSize: 20, catalogListView: 'wrong' },
  { items: [{ _id: 'p' }], total: 1, page: 1, pageSize: 20, catalogListView: listView },
  {
    items: [{ _id: 'p', [listMarker]: 'wrong' }],
    total: 1,
    page: 1,
    pageSize: 20,
    catalogListView: listView,
  },
])
  test(`requested list view refuses unconfirmed summary ${JSON.stringify(response)}`, async (t) => {
    storage(t);
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ ok: true, data: response })),
    );
    await assert.rejects(
      listRecords({ collection: 'products', catalogListView: listView }),
      (e) => e instanceof AdminApiError && e.code === 'INVALID_RESPONSE',
    );
  });
for (const marker of [listView, null, false])
  test(`raw product get refuses summary marker even when ID matches: ${marker}`, async (t) => {
    storage(t);
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify({ ok: true, data: { _id: 'p', [listMarker]: marker } })),
    );
    await assert.rejects(
      getRecord('products', 'p'),
      (e) => e instanceof AdminApiError && e.code === 'INVALID_RESPONSE',
    );
  });
test('legacy list client never silently accepts product summaries', async (t) => {
  storage(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            items: [{ _id: 'p', [listMarker]: listView }],
            total: 1,
            page: 1,
            pageSize: 20,
            catalogListView: listView,
          },
        }),
      ),
  );
  await assert.rejects(
    listRecords({ collection: 'products' }),
    (e) => e instanceof AdminApiError && e.code === 'INVALID_RESPONSE',
  );
});

for (const response of [
  {
    items: [{ _id: 'p', [listMarker]: listView, name: 'a'.repeat(8192) }],
    total: 1,
    page: 1,
    pageSize: 20,
    catalogListView: listView,
  },
  {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    catalogListView: listView,
    extra: 'a'.repeat(1024 * 1024),
  },
  {
    items: [{ _id: 'p', [listMarker]: listView, _adminProductListLimited: 'yes' }],
    total: 1,
    page: 1,
    pageSize: 20,
    catalogListView: listView,
  },
  {
    items: [{ _id: 'p', [listMarker]: listView, _adminProductListCoreIncomplete: true }],
    total: 1,
    page: 1,
    pageSize: 20,
    catalogListView: listView,
  },
])
  test(`product summary refuses oversized or inconsistent limited DTO: ${JSON.stringify(response).slice(0, 160)}`, async (t) => {
    storage(t);
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ ok: true, data: response })),
    );
    await assert.rejects(
      listRecords({ collection: 'products', catalogListView: listView }),
      (error) => error instanceof AdminApiError && error.code === 'INVALID_RESPONSE',
    );
  });
test('complete product GET keeps large original metadata rather than applying the list budget', async (t) => {
  storage(t);
  const raw = {
    _id: 'p',
    description: '中'.repeat(100000),
    alibabaSourceReview: { modelNumbers: Array.from({ length: 100 }, () => '中'.repeat(256)) },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ ok: true, data: raw })),
  );
  assert.deepEqual(await getRecord('products', 'p'), raw);
});
