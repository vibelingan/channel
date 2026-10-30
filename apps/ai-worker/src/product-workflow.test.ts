import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicCatalog, parseProductPlan } from './product-workflow.ts';
test('planner cannot select tools, private connections or arbitrary URLs', () => {
  assert.throws(() =>
    parseProductPlan('{"kind":"search","query":"headphones","url":"https://private.invalid"}'),
  );
  assert.throws(() => parseProductPlan('{"kind":"sql","query":"select secret"}'));
  assert.deepEqual(
    parseProductPlan('{"kind":"clarify","question":"Which type of product do you need?"}'),
    { kind: 'clarify', question: 'Which type of product do you need?' },
  );
});
test('catalog projects only public fields and always reads current data', async () => {
  let seen = '';
  const api: typeof fetch = async (input, init) => {
    seen = String(input);
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    assert.equal(init?.redirect, 'error');
    return Response.json({
      ok: true,
      data: {
        items: [
          {
            _id: 'public-1',
            name: 'Public headphones',
            description: 'Public description',
            published: true,
            images: ['https://catalog.invalid/api/images/public-1'],
            vipPrice: 99,
            privateNote: 'DO NOT RETURN',
          },
        ],
      },
    });
  };
  const catalog = new PublicCatalog('https://catalog.invalid', api);
  const result = await catalog.execute(
    { kind: 'search', query: 'headphones' },
    new AbortController().signal,
  );
  assert.ok(seen.startsWith('https://catalog.invalid/api/products?'));
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]?.imageUrl, '/api/images/public-1');
  assert.equal(JSON.stringify(result).includes('vipPrice'), false);
  assert.equal(JSON.stringify(result).includes('DO NOT RETURN'), false);
});

test('current lookup fingerprints changes and reports withdrawn ids', async () => {
  let version = 1;
  const api: typeof fetch = async (input) =>
    String(input).endsWith('/p2')
      ? new Response(null, { status: 404 })
      : Response.json({
          ok: true,
          data: {
            _id: 'p1',
            name: 'Headphones',
            description: `Version ${version}`,
            published: true,
            images: ['https://other.invalid/private.png'],
          },
        });
  const catalog = new PublicCatalog('https://catalog.invalid', api);
  const action = { kind: 'lookup' as const, ids: ['p1', 'p2'] };
  const first = await catalog.execute(action, new AbortController().signal);
  version = 2;
  const next = await catalog.execute(action, new AbortController().signal);
  assert.notEqual(first.products[0]?.revision, next.products[0]?.revision);
  assert.equal(next.products[0]?.imageUrl, undefined);
  assert.deepEqual(next.unavailableProductIds, ['p2']);
});
test('catalog rejects malformed, oversized, failed and unsafe-origin responses', async () => {
  for (const origin of [
    'https://user:pass@catalog.invalid',
    'http://metadata.internal',
    'https://catalog.invalid/path',
    'https://catalog.invalid/?token=secret',
  ])
    assert.throws(() => new PublicCatalog(origin));
  for (const response of [
    new Response(null, { status: 503 }),
    Response.json({ ok: true, data: { items: 'bad' } }),
    new Response('x'.repeat(262145)),
  ]) {
    const catalog = new PublicCatalog('https://catalog.invalid', async () => response);
    await assert.rejects(() =>
      catalog.execute({ kind: 'search', query: 'headphones' }, new AbortController().signal),
    );
  }
});
test('a detail endpoint cannot substitute a different product identity', async () => {
  const catalog = new PublicCatalog('https://catalog.invalid', async () =>
    Response.json({ ok: true, data: { _id: 'wrong', name: 'Wrong product', published: true } }),
  );
  await assert.rejects(() =>
    catalog.execute({ kind: 'lookup', ids: ['expected'] }, new AbortController().signal),
  );
});
