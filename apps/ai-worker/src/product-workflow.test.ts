import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicCatalog, isCatalogCursor, parseProductPlan } from './product-workflow.ts';
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

test('category fallback is a bounded internal search plan without extra tool arguments', () => {
  assert.deepEqual(
    parseProductPlan(
      '{"kind":"search","query":"wireless headphones logo","fallbackQuery":"headphones"}',
    ),
    { kind: 'search', query: 'wireless headphones logo', fallbackQuery: 'headphones' },
  );
  for (const patch of [
    { fallbackQuery: '' },
    { fallbackQuery: 'x'.repeat(81) },
    { fallbackQuery: 'headphones', url: 'https://private.invalid' },
  ])
    assert.throws(() =>
      parseProductPlan(JSON.stringify({ kind: 'search', query: 'wireless headphones', ...patch })),
    );
});

test('empty precise search may broaden once, using only the same public catalog', async () => {
  const queries: string[] = [];
  const catalog = new PublicCatalog('https://catalog.invalid', async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://catalog.invalid');
    queries.push(url.searchParams.get('search') ?? '');
    return Response.json({
      ok: true,
      data: {
        items: queries.length === 1 ? [] : [{ _id: 'p1', name: 'Headphones', published: true }],
      },
    });
  });
  const result = await catalog.execute(
    { kind: 'search', query: 'wireless headphones logo', fallbackQuery: 'headphones' },
    new AbortController().signal,
  );
  assert.equal(result.products.length, 1);
  assert.deepEqual(queries, ['wireless headphones logo', 'headphones']);
  assert.match(result.text, /broader/);
  assert.match(result.text, /confirm/);
});

test('fallback stops after two empty searches and never retries a failed service', async () => {
  for (const fail of [false, true]) {
    let calls = 0;
    const catalog = new PublicCatalog('https://catalog.invalid', async () => {
      calls++;
      return fail
        ? new Response(null, { status: 503 })
        : Response.json({ ok: true, data: { items: [] } });
    });
    const run = () =>
      catalog.execute(
        { kind: 'search', query: 'robots neon', fallbackQuery: 'robots' },
        new AbortController().signal,
      );
    if (fail) await assert.rejects(run);
    else assert.equal((await run()).kind, 'no_match');
    assert.equal(calls, fail ? 1 : 2);
  }
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

test('catalog uses a bounded configurable deadline and refuses invalid deadlines', async () => {
  const api: typeof fetch = async (_url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(Response.json({ ok: true, data: { items: [] } })),
        1000,
      );
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('deadline'));
        },
        { once: true },
      );
    });
  await assert.rejects(
    new PublicCatalog('https://catalog.invalid', api, false, 20).execute(
      { kind: 'search', query: 'headphones' },
      new AbortController().signal,
    ),
    /deadline/,
  );
  assert.throws(() => new PublicCatalog('https://catalog.invalid', api, false, 0));
});
test('inquiry and safe help plans cannot grant submission authority or carry arbitrary fields', () => {
  assert.deepEqual(
    parseProductPlan(
      '{"kind":"inquiry","summary":"700 headphones with logo","productId":"public-1"}',
    ),
    { kind: 'inquiry', summary: '700 headphones with logo', productId: 'public-1' },
  );
  assert.throws(() => parseProductPlan('{"kind":"inquiry","summary":"need","send":true}'));
  assert.throws(() => parseProductPlan('{"kind":"help","topic":"delete"}'));
  assert.throws(() =>
    parseProductPlan('{"kind":"help","topic":"greeting","text":"invented commitments"}'),
  );
});

/** A keyword catalog with `count` matches, paged like the public API. */
function pagedCatalog(count: number, facts: (n: number) => string = () => 'Wireless.') {
  const reads: Array<{ page: number; pageSize: number }> = [];
  const catalog = new PublicCatalog('https://catalog.invalid', async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page'));
    const pageSize = Number(url.searchParams.get('pageSize'));
    reads.push({ page, pageSize });
    const items = Array.from({ length: count }, (_, i) => ({
      _id: `p${String(i + 1).padStart(3, '0')}`,
      name: `Product ${i + 1}`,
      description: facts(i + 1),
      published: true,
    })).slice((page - 1) * pageSize, page * pageSize);
    return Response.json({ ok: true, data: { items, total: count, page, pageSize } });
  });
  return { catalog, reads };
}
const search = (must?: string[]) => ({
  kind: 'search' as const,
  query: 'earbuds',
  ...(must ? { must } : {}),
});

test('hundred_matches_show_at_most_five and read a bounded candidate page', async () => {
  const { catalog, reads } = pagedCatalog(100);
  const result = await catalog.execute(search(), new AbortController().signal);
  assert.equal(result.products.length, 5);
  assert.deepEqual(reads, [{ page: 1, pageSize: 20 }]);
  assert.deepEqual(result.resultSet, { batch: 1, hasMore: true });
  // Three matches are three cards, not padded, and nothing more is claimed.
  const few = await pagedCatalog(3).catalog.execute(search(), new AbortController().signal);
  assert.equal(few.products.length, 3);
  assert.deepEqual(few.resultSet, { batch: 1, hasMore: false });
  assert.equal('catalogCursor' in few, false);
});

test('unknown_total_is_not_fabricated: a result set says only whether more exist', async () => {
  const { catalog } = pagedCatalog(100);
  const result = await catalog.execute(search(), new AbortController().signal);
  assert.deepEqual(Object.keys(result.resultSet ?? {}).sort(), ['batch', 'hasMore']);
  assert.doesNotMatch(result.text, /\d/);
});

test('next_batch_deduplicates_seen_ids and continues across candidate pages', async () => {
  const { catalog, reads } = pagedCatalog(23);
  const signal = new AbortController().signal;
  const shown: string[] = [];
  let result = await catalog.execute(search(), signal);
  shown.push(...result.products.map((p) => p.id));
  for (let batch = 2; result.catalogCursor; batch++) {
    result = await catalog.execute(
      { kind: 'more', after: 'question-1' },
      signal,
      result.catalogCursor,
    );
    assert.equal(result.resultSet?.batch, batch);
    shown.push(...result.products.map((p) => p.id));
  }
  assert.equal(shown.length, 23);
  assert.equal(new Set(shown).size, 23);
  assert.equal(result.resultSet?.hasMore, false);
  // Never more than one extra page per request.
  assert.ok(reads.length <= 10);
  assert.ok(reads.every((read) => read.pageSize === 20 && read.page <= 2));
});

test('all twenty batches are reachable, and the last never promises a twenty-first', async () => {
  const signal = new AbortController().signal;
  for (const count of [100, 120]) {
    const { catalog } = pagedCatalog(count);
    let result = await catalog.execute(search(), signal);
    let shown = result.products.length;
    while (result.catalogCursor) {
      // The worker refuses a cursor this check rejects, ending the list early.
      assert.ok(isCatalogCursor(result.catalogCursor), `batch ${result.catalogCursor.batch}`);
      result = await catalog.execute(
        { kind: 'more', after: 'question-1' },
        signal,
        result.catalogCursor,
      );
      shown += result.products.length;
    }
    assert.equal(shown, 100);
    assert.deepEqual(result.resultSet, { batch: 20, hasMore: false });
  }
});

test('anc_is_not_inferred_from_enc, and proven features rank first without reordering ties', async () => {
  const { catalog } = pagedCatalog(4, (n) =>
    n === 1
      ? 'ENC call noise reduction.'
      : n === 2
        ? 'Hybrid ANC with active noise cancellation.'
        : n === 3
          ? 'Noise reduction for calls.'
          : 'Active noise cancelling, IPX5.',
  );
  const result = await catalog.execute(search(['ANC']), new AbortController().signal);
  assert.deepEqual(
    result.products.map((p) => [p.id, p.toConfirm]),
    [
      ['p002', undefined],
      ['p004', undefined],
      ['p001', ['ANC']],
      ['p003', ['ANC']],
    ],
  );
  assert.match(result.text, /to confirm/);
  // A feature that is not ANC/ENC is matched on the public words only.
  const ipx = await catalog.execute(search(['IPX5']), new AbortController().signal);
  assert.deepEqual(
    ipx.products.filter((p) => !p.toConfirm).map((p) => p.id),
    ['p004'],
  );
});

test('the model plans required features but can never pick a cursor', () => {
  assert.deepEqual(
    parseProductPlan(
      '{"kind":"search","query":"earbuds","fallbackQuery":"earbuds","must":["ANC"]}',
    ),
    { kind: 'search', query: 'earbuds', fallbackQuery: 'earbuds', must: ['ANC'] },
  );
  assert.throws(() => parseProductPlan('{"kind":"more","after":"question-1"}'));
  assert.throws(() =>
    parseProductPlan('{"kind":"search","query":"earbuds","must":["a","b","c","d","e"]}'),
  );
});
