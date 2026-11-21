import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CatalogPriceSummary } from '@vibelingan-channel/shared/catalog-detail';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { parseDocument } from 'yaml';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import type { CatalogContent, SharedDetailContent } from '../../i18n/catalog.ts';
import { CatalogFamilyPage } from '../../islands/shop/CatalogFamilyPage.tsx';
import { categoryPage } from './category-snapshot.ts';
import { productPageDescriptor } from './product-page.ts';
import {
  PUBLIC_SNAPSHOT_READS,
  type ProductSnapshot,
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
const headphoneRow = { ...row, productFamily: 'headphones' };
const publicPriceSummary: CatalogPriceSummary = {
  source: 'sku',
  variantId: 'variant-1',
  pricing: {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 100,
    tiers: [
      { minimumQuantity: 100, maximumQuantity: 499, unitAmountMinor: 325 },
      { minimumQuantity: 500, unitAmountMinor: 234 },
    ],
  },
};

function renderHeadphones(snapshot: ProductSnapshot): string {
  const raw = readFileSync(new URL('../../i18n/content/catalog/en-US.md', import.meta.url), 'utf8');
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter);
  const content: CatalogContent & { sharedDetail: SharedDetailContent } = parseDocument(
    frontmatter[1],
  ).toJS();
  const family = content.families.find(({ key }) => key === 'headphones');
  assert.ok(family);
  return renderToString(
    createElement(CatalogFamilyPage, {
      content,
      family,
      bootstrap: categoryPage(snapshot, 'headphones'),
      previewContent: content.sharedDetail,
    }),
  );
}

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

test('size hints preserve the legacy content revision and saved strict detail shape', async () => {
  const source = '/api/images/image-1';
  const imagePresentation = { [source]: [{ url: `${source}?w=160`, width: 160, height: 100 }] };
  const baseProduct = { ...row, images: [source] };
  const api =
    (
      product: typeof baseProduct & { imagePresentation?: typeof imagePresentation },
    ): typeof fetch =>
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/detail')) return new Response('', { status: 404 });
      return Response.json({
        ok: true,
        data:
          url.pathname === `/api/products/${row._id}`
            ? product
            : { items: [product], page: 1, pageSize: 48, total: 1 },
      });
    };
  const before = await collectProductSnapshot(origin, origin, api(baseProduct));
  const after = await collectProductSnapshot(
    origin,
    origin,
    api({ ...baseProduct, imagePresentation }),
  );
  assert.equal(after.products[0]?.revision, before.products[0]?.revision);
  assert.deepEqual(after.products[0]?.product.imagePresentation, imagePresentation);
  const original = transport({ ...detailFixture(), imagePresentation });
  const approved = await collectProductSnapshot(origin, origin, async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/detail'))
      assert.equal(new URL(String(input)).searchParams.has('media'), false);
    return original(input, init);
  });
  assert.equal(approved.products[0]?.detail?.imagePresentation, undefined);
  assert.equal(approved.products[0]?.detail?.revision, 'approved-r1');
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

function refreshTransport(
  items: Array<typeof row & { priceSummary?: unknown }>,
  counts: Map<string, number>,
  revision: string | null = 'approved-r1',
): typeof fetch {
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
    if (url.pathname.endsWith('/detail')) {
      if (revision === null)
        return Response.json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Legacy product' } },
          { status: 404 },
        );
      return Response.json({
        ok: true,
        data: { ...detailFixture(), _id: id, name: product.name, revision },
      });
    }
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

test('the captured approved price summary is already visible on the initial category HTML', async () => {
  const priced = { ...headphoneRow, priceSummary: publicPriceSummary, vipPrice: 1 };
  const capture = await collectProductSnapshot(
    origin,
    origin,
    refreshTransport([priced], new Map()),
  );
  const entry = capture.products[0];
  assert.ok(entry);
  assert.match(renderHeadphones(capture), /data-product-card-price[^>]*>From \$2\.34</);
  assert.deepEqual(entry.product.priceSummary, publicPriceSummary);
  assert.equal(Object.hasOwn(entry.product, 'vipPrice'), false);

  const accepted = await collectProductSnapshot(
    origin,
    origin,
    refreshTransport([headphoneRow], new Map()),
  );
  const oldEntry = accepted.products[0];
  assert.ok(oldEntry);
  assert.deepEqual(decodeProductSnapshot(accepted, origin), accepted);
  assert.deepEqual(
    reuseAcceptedProductSnapshot(capture, ['/products/p-canonical-product/'], origin),
    capture,
  );
  assert.deepEqual(entry.detail, oldEntry.detail);
  assert.deepEqual(
    productPageDescriptor(entry, origin, 'Example'),
    productPageDescriptor(oldEntry, origin, 'Example'),
  );
});

test('missing or malformed summaries never manufacture a category price', async () => {
  const malformed = { ...publicPriceSummary, costPrice: 1 };
  const quoteOnly = {
    source: 'website',
    pricing: { mode: 'negotiable', minimumOrderQuantity: 200 },
  };
  for (const priceSummary of [undefined, malformed, quoteOnly]) {
    const snapshot = await collectProductSnapshot(
      origin,
      origin,
      refreshTransport([{ ...headphoneRow, priceSummary }], new Map()),
    );
    assert.match(renderHeadphones(snapshot), /data-product-card-price[^>]*>Request a Quote</);
    assert.deepEqual(
      snapshot.products[0]?.product.priceSummary,
      priceSummary === quoteOnly ? quoteOnly : undefined,
    );
    assert.equal(JSON.stringify(snapshot).includes('costPrice'), false);
  }
});

test('legacy snapshots keep the previous detail shape and revision even if a summary is supplied', async () => {
  const old = await collectProductSnapshot(
    origin,
    origin,
    refreshTransport([headphoneRow], new Map(), null),
  );
  const priced = { ...headphoneRow, priceSummary: publicPriceSummary };
  const candidate = await collectProductSnapshot(
    origin,
    origin,
    refreshTransport([priced], new Map(), null),
  );
  assert.match(old.products[0]?.revision ?? '', /^legacy-/);
  assert.deepEqual(candidate, old);
  const entry = old.products[0];
  assert.ok(entry);
  assert.deepEqual(
    decodeProductSnapshot(
      {
        ...old,
        products: [{ ...entry, product: { ...entry.product, priceSummary: publicPriceSummary } }],
      },
      origin,
    ),
    old,
  );
});

test('incremental capture refreshes only the affected price card and matches full capture', async () => {
  const second = { ...headphoneRow, _id: 'second' };
  const oldProducts = [second, headphoneRow];
  const original = refreshTransport(oldProducts, new Map());
  const heads = [refreshHead(row._id), refreshHead(second._id)];
  const accepted = await collectProductRefresh(
    await collectProductSnapshot(origin, origin, original),
    heads,
    origin,
    origin,
    original,
  );
  const newProducts = [second, { ...headphoneRow, priceSummary: publicPriceSummary }];
  const details = new Map<string, number>();
  const changed = await collectProductRefresh(
    accepted,
    heads,
    origin,
    origin,
    refreshTransport(newProducts, details),
  );
  assert.deepEqual([...details], [[row._id, 2]]);
  const before = categoryPage(accepted, 'headphones');
  const after = categoryPage(changed, 'headphones');
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(
    after.items.map(({ _id }) => _id),
    before.items.map(({ _id }) => _id),
  );

  const fresh = await collectProductSnapshot(
    origin,
    origin,
    refreshTransport(newProducts, new Map()),
  );
  assert.deepEqual(after, categoryPage(fresh, 'headphones'));
  details.clear();
  const same = await collectProductRefresh(
    changed,
    heads,
    origin,
    origin,
    refreshTransport(newProducts, details),
  );
  assert.deepEqual(same, changed);
  assert.equal(details.size, 0);
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

test('a detail-only approval revision refreshes the snapshot without increasing its public version', async () => {
  const head = refreshHead(row._id);
  const initial = await collectProductSnapshot(origin, origin, refreshTransport([row], new Map()));
  const accepted = await collectProductRefresh(
    initial,
    [head],
    origin,
    origin,
    refreshTransport([row], new Map()),
  );
  const nextHead = { ...head, detailRevision: 'approved-r2' };
  const calls = new Map<string, number>();
  const requests: URL[] = [];
  const current = refreshTransport([row], calls, nextHead.detailRevision);
  const result = await collectProductRefresh(
    accepted,
    [nextHead],
    origin,
    origin,
    async (input, init) => {
      requests.push(new URL(String(input)));
      return current(input, init);
    },
  );
  const previous = accepted.products[0];
  const updated = result.products[0];
  assert.ok(previous?.detail && updated?.detail);
  assert.equal(updated.revision, 'approved-r2');
  assert.equal(updated.detail.revision, nextHead.detailRevision);
  assert.deepEqual(updated.product, previous.product);
  const { revision: _before, ...beforeBody } = previous.detail;
  const { revision: _after, ...afterBody } = updated.detail;
  assert.deepEqual(afterBody, beforeBody);
  assert.deepEqual(updated.publicVersion, previous.publicVersion);
  assert.equal(updated.publicVersion?.sequence, head.sequence);
  assert.equal(calls.get(row._id), 2);
  assert.deepEqual(
    requests
      .filter((url) => url.pathname.endsWith('/detail'))
      .map((url) => url.searchParams.get('revision')),
    [null, 'approved-r2'],
  );
  assert.deepEqual(
    requests
      .filter((url) => url.pathname === '/api/products')
      .map((url) => url.searchParams.get('page')),
    ['1', '1'],
  );
  assert.equal(previous.detail.revision, 'approved-r1');
});

for (const detailRevision of ['approved-r1', null]) {
  test(`an unchanged tracked ${detailRevision ?? 'legacy'} entry only rechecks inventory`, async () => {
    const head = { ...refreshHead(row._id), detailRevision };
    const initial = await collectProductSnapshot(
      origin,
      origin,
      refreshTransport([row], new Map(), detailRevision),
    );
    const accepted = await collectProductRefresh(
      initial,
      [head],
      origin,
      origin,
      refreshTransport([row], new Map(), detailRevision),
    );
    const requests: string[] = [];
    const current = refreshTransport([row], new Map(), detailRevision);
    const result = await collectProductRefresh(
      accepted,
      [head],
      origin,
      origin,
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        assert.equal(path, '/api/products', 'unchanged details must not be fetched');
        return current(input, init);
      },
    );
    assert.deepEqual(result.products, accepted.products);
    assert.equal(result.products[0]?.detail?.revision ?? null, detailRevision);
    assert.deepEqual(requests, ['/api/products', '/api/products']);
  });
}

test('a revision-only refresh rejects detail that does not match the tracked revision', async () => {
  const head = refreshHead(row._id);
  const initial = await collectProductSnapshot(origin, origin, refreshTransport([row], new Map()));
  const accepted = await collectProductRefresh(
    initial,
    [head],
    origin,
    origin,
    refreshTransport([row], new Map()),
  );
  await assert.rejects(
    collectProductRefresh(
      accepted,
      [{ ...head, detailRevision: 'approved-r2' }],
      origin,
      origin,
      refreshTransport([row], new Map(), 'approved-r3'),
    ),
    /Tracked product revision changed/,
  );
  assert.equal(accepted.products[0]?.detail?.revision, 'approved-r1');
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

test('a snapshot overlaps public reads up to its fixed bound and still reads every product twice', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...row, _id: `product-${i}` }));
  let inFlight = 0;
  let peak = 0;
  const reads = new Map<string, number>();
  const api: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/products')
      return Response.json({ ok: true, data: { items: rows, page: 1, pageSize: 48, total: 30 } });
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (url.pathname.endsWith('/detail'))
        return new Response(JSON.stringify({ ok: false, data: null }), { status: 404 });
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return Response.json({ ok: true, data: rows.find((r) => r._id === id) });
    } finally {
      inFlight--;
    }
  };
  const snapshot = await collectProductSnapshot(origin, origin, api);
  assert.equal(snapshot.products.length, 30);
  assert.equal(PUBLIC_SNAPSHOT_READS, 12);
  assert.equal(peak, PUBLIC_SNAPSHOT_READS);
  // One capture read and one verification read per product, never fewer.
  assert.deepEqual([...new Set(reads.values())], [2]);
  assert.equal(reads.size, 30);
});

test('inventory pages after the first are read together and must all agree on the totals', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    ...row,
    _id: `item-${String(i).padStart(3, '0')}`,
  }));
  const page = (n: number, overrides: Record<string, unknown> = {}) => ({
    items: rows.slice((n - 1) * 48, n * 48),
    page: n,
    pageSize: 48,
    total: 100,
    ...overrides,
  });
  let inFlight = 0;
  let peak = 0;
  const pagesRead: number[] = [];
  const api =
    (broken?: number): typeof fetch =>
    async (input) => {
      const url = new URL(String(input));
      const n = Number(url.searchParams.get('page'));
      pagesRead.push(n);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return Response.json({ ok: true, data: page(n, n === broken ? { total: 101 } : {}) });
    };
  const paths = await collectPublicProductPaths(origin, api());
  assert.equal(paths.length, 100);
  assert.deepEqual([...pagesRead].sort(), [1, 2, 3]);
  // Pages 2 and 3 overlap once page 1 named the total.
  assert.equal(peak, 2);
  await assert.rejects(collectPublicProductPaths(origin, api(3)), /pagination changed/);
});
