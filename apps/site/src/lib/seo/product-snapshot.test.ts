import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import {
  collectProductSnapshot,
  collectPublicProductPaths,
  decodeProductSnapshot,
} from './product-snapshot.ts';

const origin = 'https://example.com';
const row = {
  _id: 'canonical-product',
  name: 'Headset',
  description: 'A public description.',
  category: '',
};
function transport(detail: unknown = detailFixture(), status = 200): typeof fetch {
  return async (input, init) => {
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    const url = new URL(String(input));
    if (url.pathname.endsWith('/detail'))
      return new Response(JSON.stringify({ ok: status === 200, data: detail }), { status });
    return Response.json({ ok: true, data: { items: [row], page: 1, pageSize: 48, total: 1 } });
  };
}

test('every public ID survives without a slug or family and unknown/private fields never serialize', async () => {
  const snapshot = await collectProductSnapshot(origin, origin, transport());
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0]?.detail?.revision, 'approved-r1');
  const input = JSON.parse(JSON.stringify(snapshot));
  input.products[0].product.vipPrice = 1;
  input.products[0].product.adminSecret = 'private';
  assert.doesNotMatch(
    JSON.stringify(decodeProductSnapshot(input, origin)),
    /vipPrice|private|adminSecret/,
  );
  assert.throws(() => decodeProductSnapshot({ ...snapshot, products: [] }, origin));
  assert.throws(() => decodeProductSnapshot({ ...snapshot, purpose: 'fixture' }, origin));
});

test('detail 404 falls back to the anonymous base product, but outages never silently remove a product', async () => {
  const api: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === `/api/products/${row._id}`) return Response.json({ ok: true, data: row });
    return transport(undefined, 404)(input, init);
  };
  const snapshot = await collectProductSnapshot(origin, origin, api);
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0]?.detail, undefined);
  assert.match(snapshot.products[0]?.revision ?? '', /^legacy-/);
  await assert.rejects(() => collectProductSnapshot(origin, origin, transport(undefined, 503)));
});

test('changing public inventory aborts instead of producing a partial sitemap', async () => {
  let count = 0;
  const api: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/products') {
      count++;
      return Response.json({
        ok: true,
        data: { items: [row], page: 1, pageSize: 48, total: count === 1 ? 1 : 2 },
      });
    }
    return transport()(input, init);
  };
  await assert.rejects(() => collectProductSnapshot(origin, origin, api));
});

test('duplicate public inventory identities are rejected before detail acquisition', async () => {
  const api: typeof fetch = async () =>
    Response.json({ ok: true, data: { items: [row, row], page: 1, pageSize: 48, total: 2 } });
  await assert.rejects(
    () => collectProductSnapshot(origin, origin, api),
    /Duplicate public inventory ID/,
  );
});

test('fresh recovery allowlists use only anonymous inventory requests and share canonical product identities', async () => {
  let calls = 0;
  const api: typeof fetch = async (input, init) => {
    calls++;
    assert(!new URL(String(input)).pathname.endsWith('/detail'));
    return transport()(input, init);
  };
  assert.deepEqual(await collectPublicProductPaths(origin, api), [
    '/products/p-canonical-product/',
  ]);
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      collectPublicProductPaths(origin, async () =>
        Response.json({ ok: true, data: { items: [], total: 1, page: 1, pageSize: 48 } }),
      ),
    /incomplete/,
  );
});
