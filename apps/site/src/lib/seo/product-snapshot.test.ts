import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import {
  collectProductRefresh,
  collectProductSnapshot,
  collectPublicProductPaths,
  decodeProductSnapshot,
  reuseAcceptedProductSnapshot,
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

test('emergency reuse preserves accepted detail and interactions, filters withdrawals and refuses to drop new public IDs', async () => {
  const accepted = await collectProductSnapshot(origin, origin, transport());
  const reused = reuseAcceptedProductSnapshot(accepted, ['/products/p-canonical-product/'], origin);
  assert.deepEqual(reused.products, accepted.products);
  assert(reused.products[0]?.detail);
  assert.equal(reuseAcceptedProductSnapshot(accepted, [], origin).products.length, 0);
  assert.throws(
    () => reuseAcceptedProductSnapshot(accepted, ['/products/p-new/'], origin),
    /New public products/,
  );
  assert.throws(() =>
    reuseAcceptedProductSnapshot(
      { ...accepted, purpose: 'fixture' },
      ['/products/p-canonical-product/'],
      origin,
    ),
  );
  assert.throws(() =>
    reuseAcceptedProductSnapshot(
      accepted,
      ['/products/p-canonical-product/', '/products/p-canonical-product/'],
      origin,
    ),
  );
});

function refreshTransport(items: Array<typeof row>, counts: Map<string, number>): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/products')
      return Response.json({
        ok: true,
        data: { items, total: items.length, page: 1, pageSize: 48 },
      });
    const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const product = items.find((p) => p._id === id);
    assert.ok(product);
    if (url.pathname.endsWith('/detail'))
      return Response.json({ ok: true, data: { ...detailFixture(), _id: id, name: product.name } });
    return Response.json({ ok: true, data: product });
  };
}
const refreshHead = (productId: string, visible = true) => ({
  productId,
  visible,
  sequence: 1,
  semanticHash: 'a'.repeat(64),
  detailRevision: visible ? 'approved-r1' : null,
  changedAt: null,
});

test('incremental capture reads only changed and new product details, retaining every other accepted entry', async () => {
  const second = { ...row, _id: 'second', name: 'Second headset' };
  const accepted = await collectProductSnapshot(
    origin,
    origin,
    refreshTransport([row, second], new Map()),
  );
  const changed = { ...row, name: 'Updated headset' };
  const calls = new Map<string, number>();
  const result = await collectProductRefresh(
    accepted,
    [refreshHead(row._id)],
    origin,
    origin,
    refreshTransport([changed, second], calls),
  );
  assert.equal(result.total, 2);
  assert.equal(
    result.products.find((p) => p.product._id === row._id)?.product.name,
    'Updated headset',
  );
  assert.equal(calls.get('second'), undefined);
  assert.equal(calls.get(row._id), 2);
  assert.deepEqual(
    result.products.find((p) => p.product._id === 'second'),
    accepted.products.find((p) => p.product._id === 'second'),
  );
  assert.equal(
    result.products.find((p) => p.product._id === row._id)?.publicVersion?.changedAt,
    null,
  );
});

test('withdrawal requires an explicit nonvisible head, and an outage keeps the old candidate intact', async () => {
  const accepted = await collectProductSnapshot(origin, origin, transport());
  const empty: typeof fetch = async () =>
    Response.json({ ok: true, data: { items: [], total: 0, page: 1, pageSize: 48 } });
  await assert.rejects(collectProductRefresh(accepted, [], origin, origin, empty), /withdrawal/);
  const result = await collectProductRefresh(
    accepted,
    [refreshHead(row._id, false)],
    origin,
    origin,
    empty,
  );
  assert.equal(result.total, 0);
  await assert.rejects(
    collectProductRefresh(
      accepted,
      [refreshHead(row._id)],
      origin,
      origin,
      transport(undefined, 503),
    ),
  );
  assert.equal(accepted.total, 1);
});

test('new public IDs need a tracked version before they enter a complete candidate', async () => {
  const accepted = await collectProductSnapshot(origin, origin, transport());
  const next = { ...row, _id: 'new-product', name: 'New headset' };
  await assert.rejects(
    collectProductRefresh(accepted, [], origin, origin, refreshTransport([row, next], new Map())),
    /tracked/,
  );
  const result = await collectProductRefresh(
    accepted,
    [refreshHead(next._id)],
    origin,
    origin,
    refreshTransport([row, next], new Map()),
  );
  assert.equal(result.total, 2);
});
