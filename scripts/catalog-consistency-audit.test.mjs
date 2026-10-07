import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePriceSummary } from '../packages/shared/src/catalog/price-summary.ts';
import { auditCatalog, auditExitCode, cardPriceFromDetail } from './catalog-consistency-audit.mjs';

const tiered = (amounts, currency = 'USD') => ({
  mode: 'tiered',
  currency,
  tiers: amounts.map((unitAmountMinor, index) =>
    index === amounts.length - 1
      ? { minimumQuantity: 10 ** (index + 1), unitAmountMinor }
      : {
          minimumQuantity: 10 ** (index + 1),
          maximumQuantity: 10 ** (index + 2) - 1,
          unitAmountMinor,
        },
  ),
});
const offer = (pricing) => ({ kind: 'regular', basis: 'source-quote', pricing });
const variant = (id, pricing) => ({
  id,
  options: [{ name: 'Color', value: id }],
  inventory: { state: 'unknown' },
  images: [],
  offers: [offer(pricing)],
});
const detail = (id, variants, extra = {}) => ({
  schemaVersion: 'catalog-product-detail-v1',
  _id: id,
  name: `Product ${id}`,
  revision: 'r1',
  images: [`/api/images/${id}-main`],
  facts: [],
  offers: [],
  variants: { items: variants, total: variants.length, page: 1, pageSize: 50, hasMore: false },
  ...extra,
});
const card = (id, priceSummary, extra = {}) => ({
  _id: id,
  name: `Product ${id}`,
  images: [`https://api.example.test/api/images/${id}-main`],
  ...(priceSummary ? { priceSummary } : {}),
  ...extra,
});
const ok = (data) => ({ status: 200, body: { ok: true, data } });
const notFound = { status: 404, body: { ok: false, error: { code: 'NOT_FOUND' } } };

/** In-memory public API: a list of cards plus per-product detail responses. */
function fakeApi(cards, details, pageSize = 48) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    const url = new URL(path, 'http://audit.test');
    if (url.pathname === '/api/products') {
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('pageSize'));
      assert.equal(size, pageSize);
      const items = cards.slice((page - 1) * size, page * size);
      return ok({ items, total: cards.length, page, pageSize: size });
    }
    const match = url.pathname.match(/^\/api\/products\/([^/]+)\/detail$/);
    const response = match && details[decodeURIComponent(match[1])];
    if (!response) return notFound;
    return typeof response === 'function' ? response(url) : response;
  };
  return { get, calls };
}

const black = tiered([661, 555, 476]);
const white = tiered([430]);
const approved = detail('a', [variant('black', black), variant('white', white)]);
const matchingSummary = { source: 'sku', variantId: 'white', pricing: white };

test('list and product page agree → exit 0, every product counted once', async () => {
  const api = fakeApi([card('a', matchingSummary)], { a: ok(approved) });
  const report = await auditCatalog(api.get);
  assert.equal(report.listed, 1);
  assert.equal(report.approved, 1);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.fallback, []);
  assert.equal(auditExitCode(report), 0);
});

test('a card price that differs from the page → exit 1 and the product named', async () => {
  const stale = { source: 'sku', variantId: 'black', pricing: black };
  const api = fakeApi([card('a', stale)], { a: ok(approved) });
  const report = await auditCatalog(api.get);
  assert.deepEqual(
    report.mismatches.map(({ productId, fields }) => [productId, fields]),
    [['a', ['priceSummary']]],
  );
  assert.equal(auditExitCode(report), 1);
});

test('name and main photo are compared; the photo by image id, not by URL form', async () => {
  const api = fakeApi(
    [
      card('same', undefined, { images: ['https://api.example.test/api/images/same-main'] }),
      card('renamed', undefined, { name: 'Old name' }),
      card('photo', undefined, { images: ['https://api.example.test/api/images/other'] }),
    ],
    {
      same: ok(detail('same', [])),
      renamed: ok(detail('renamed', [])),
      photo: ok(detail('photo', [])),
    },
  );
  const report = await auditCatalog(api.get);
  assert.deepEqual(
    report.mismatches.map(({ productId, fields }) => [productId, fields]),
    [
      ['renamed', ['name']],
      ['photo', ['mainPhoto']],
    ],
  );
});

test('a product with no approved page is counted as fallback, not a mismatch', async () => {
  const api = fakeApi([card('a', matchingSummary), card('legacy')], { a: ok(approved) });
  const report = await auditCatalog(api.get);
  assert.deepEqual(report.fallback, ['legacy']);
  assert.deepEqual(report.mismatches, []);
  assert.equal(auditExitCode(report), 0);
  assert.equal(auditExitCode(report, { requireNoFallback: true }), 1);
});

test('every list page and every configuration page are read, pinned to one revision', async () => {
  const cards = Array.from({ length: 3 }, (_, i) => card(`p${i}`));
  const firstPage = {
    ...detail('p0', [variant('black', black)]),
    variants: { items: [variant('black', black)], total: 2, page: 1, pageSize: 50, hasMore: true },
  };
  const secondPage = {
    ...firstPage,
    variants: { items: [variant('white', white)], total: 2, page: 2, pageSize: 50, hasMore: false },
  };
  const api = fakeApi(
    [{ ...cards[0], priceSummary: matchingSummary }, cards[1], cards[2]],
    {
      p0: (url) => {
        if (url.searchParams.get('page') === '2') {
          assert.equal(url.searchParams.get('revision'), 'r1');
          return ok(secondPage);
        }
        return ok(firstPage);
      },
    },
    2,
  );
  const report = await auditCatalog(api.get, { listPageSize: 2 });
  assert.equal(report.listed, 3);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.fallback, ['p1', 'p2']);
  assert.ok(api.calls.includes('/api/products?page=2&pageSize=2'));
});

test('a product page that fails for another reason is an error, never a pass', async () => {
  const api = fakeApi([card('a', matchingSummary)], {
    a: { status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR' } } },
  });
  const report = await auditCatalog(api.get);
  assert.deepEqual(
    report.errors.map(({ productId }) => productId),
    ['a'],
  );
  assert.equal(auditExitCode(report), 1);
});

test('parity: the page price is derived exactly as approval derives it', () => {
  const page = detail('a', [variant('black', black), variant('white', white)], {
    offers: [offer({ mode: 'fixed', currency: 'USD', amountMinor: 999 })],
  });
  assert.deepEqual(
    cardPriceFromDetail(page, page.variants.items),
    derivePriceSummary({
      websitePricing: undefined,
      offers: page.offers,
      variants: page.variants.items.map(({ id, offers }) => ({ id, offers })),
    }),
  );
  const website = {
    basis: 'website-manual',
    pricing: { mode: 'negotiable', minimumOrderQuantity: 5 },
  };
  const withWebsite = { ...page, websitePricing: website };
  assert.deepEqual(cardPriceFromDetail(withWebsite, page.variants.items), {
    source: 'website',
    pricing: website.pricing,
  });
});
