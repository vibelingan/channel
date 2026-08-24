import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCurrentPublicProducts,
  createPublicCatalogPage,
} from '../../test/factories/catalog.ts';
import { fetchCatalogPage } from './catalog-api.ts';

test('preserves response order and forwards query plus AbortSignal', async (t) => {
  const originalFetch = globalThis.fetch;
  const products = createCurrentPublicProducts();
  const controller = new AbortController();
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ ok: true, data: createPublicCatalogPage({ items: products }) });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const page = await fetchCatalogPage(
    { productFamily: 'toys', categories: ['learning'], search: 'kit', page: 2, pageSize: 12 },
    controller.signal,
  );

  assert.equal(
    requestUrl,
    '/api/products?productFamily=toys&category=learning&search=kit&page=2&pageSize=12',
  );
  assert.equal(requestInit?.signal, controller.signal);
  assert.deepEqual(
    page.items.map((product) => product._id),
    products.map((product) => product._id),
  );
});

test('rejects malformed required and envelope fields while optional fields may be omitted', async (t) => {
  const originalFetch = globalThis.fetch;
  const responses = [
    createPublicCatalogPage({
      items: [{ _id: 'minimal', name: 'Minimal', productFamily: 'misc' }],
    }),
    { items: [{ _id: 'missing-family', name: 'Missing Family' }], total: 1, page: 1, pageSize: 24 },
    { items: [], total: -1, page: 1, pageSize: 24 },
  ];
  globalThis.fetch = async () => Response.json({ ok: true, data: responses.shift() });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const minimal = await fetchCatalogPage();
  assert.equal(minimal.items[0]?.name, 'Minimal');
  await assert.rejects(fetchCatalogPage(), /Invalid catalog response/);
  await assert.rejects(fetchCatalogPage(), /Invalid catalog response/);
});

test('rejects role-gated fields outside the PublicProduct base contract', async (t) => {
  const originalFetch = globalThis.fetch;
  const products = createCurrentPublicProducts();
  const invalidWirePage = {
    ...createPublicCatalogPage(),
    items: [products[0], { ...products[1], vipPrice: 5 }],
    total: 2,
  };
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      data: invalidWirePage,
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(fetchCatalogPage(), /Invalid catalog response/);
});
