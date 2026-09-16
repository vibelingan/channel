import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCatalogSnapshot } from '../tests/e2e/helpers/public-catalog-snapshot.mjs';

/** @typedef {{ items: { _id: string }[], total: number, page: number, pageSize: number }} CatalogPage */

/** @param {Partial<CatalogPage>} overrides */
function catalogBody(overrides = {}) {
  return {
    ok: true,
    data: { items: [{ _id: 'product-1' }], total: 1, page: 1, pageSize: 48, ...overrides },
  };
}

/**
 * @param {unknown} body
 * @param {Partial<import('../tests/e2e/helpers/public-catalog-snapshot.mjs').PublicCatalogResponse>} overrides
 * @returns {import('../tests/e2e/helpers/public-catalog-snapshot.mjs').PublicCatalogResponse}
 */
function responseFor(body, overrides = {}) {
  return { ok: () => true, json: async () => body, ...overrides };
}

/** @param {unknown[]} bodies */
function fakePages(bodies) {
  /** @type {{ page: number, pageSize: number }[]} */
  const calls = [];
  /** @type {import('../tests/e2e/helpers/public-catalog-snapshot.mjs').FetchPublicCatalogPage} */
  const fetchPage = async (page, pageSize) => {
    calls.push({ page, pageSize });
    assert.equal(pageSize, 100);
    assert.equal(page, calls.length);
    assert.ok(page <= bodies.length, 'must not request an unprovided page');
    return responseFor(bodies[page - 1]);
  };
  return { calls, fetchPage };
}

/** @param {number} count */
function productIds(count) {
  return Array.from({ length: count }, (_, index) => `product-${count - index}`);
}

/** @param {string[]} ids @param {number} pageSize */
function catalogPages(ids, pageSize) {
  return Array.from({ length: Math.max(1, Math.ceil(ids.length / pageSize)) }, (_, index) =>
    catalogBody({
      items: ids.slice(index * pageSize, (index + 1) * pageSize).map((_id) => ({ _id })),
      total: ids.length,
      page: index + 1,
      pageSize,
    }),
  );
}

test('collects all 90 products when requested 100 is capped to 48, including the page-2 sample', async () => {
  const ids = productIds(90);
  ids[60] = 'f15a8e4f-3f48-4021-ac3d-67bd1060836a';
  const source = fakePages(catalogPages(ids, 48));
  const snapshot = await publicCatalogSnapshot(source.fetchPage);
  assert.equal(snapshot.length, 90);
  assert.ok(snapshot.includes('f15a8e4f-3f48-4021-ac3d-67bd1060836a'));
  assert.deepEqual(snapshot, [...ids].sort());
  assert.deepEqual(source.calls, [
    { page: 1, pageSize: 100 },
    { page: 2, pageSize: 100 },
  ]);
});

for (const [total, pageSize] of [
  [0, 48],
  [1, 48],
  [48, 48],
  [49, 48],
  [100, 48],
  [100, 100],
  [20, 2],
]) {
  test(`returns a complete sorted snapshot for total=${total}, pageSize=${pageSize}`, async () => {
    const ids = productIds(total);
    const source = fakePages(catalogPages(ids, pageSize));
    assert.deepEqual(await publicCatalogSnapshot(source.fetchPage), [...ids].sort());
    assert.equal(source.calls.length, Math.max(1, Math.ceil(total / pageSize)));
  });
}

for (const [label, body] of [
  ['null envelope', null],
  ['array envelope', []],
  ['missing data', { ok: true }],
  ['null data', { ok: true, data: null }],
  ['array data', { ok: true, data: [] }],
  ['unsuccessful envelope', { ...catalogBody(), ok: false }],
  ['missing success flag', { data: catalogBody().data }],
  ['missing items', { ok: true, data: { total: 1, page: 1, pageSize: 48 } }],
  ['non-array items', { ok: true, data: { ...catalogBody().data, items: {} } }],
  ['null item', { ok: true, data: { ...catalogBody().data, items: [null] } }],
  ['missing ID', { ok: true, data: { ...catalogBody().data, items: [{}] } }],
  ['numeric ID', { ok: true, data: { ...catalogBody().data, items: [{ _id: 123 }] } }],
  ['empty ID', catalogBody({ items: [{ _id: '' }] })],
  ['blank ID', catalogBody({ items: [{ _id: '  ' }] })],
]) {
  test(`rejects ${label}`, async () => {
    const source = fakePages([body]);
    await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Malformed/);
    assert.equal(source.calls.length, 1);
  });
}

for (const field of ['total', 'page', 'pageSize']) {
  for (const value of [undefined, null, '1', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`rejects invalid ${field}=${String(value)}`, async () => {
      const body = { ok: true, data: { ...catalogBody().data, [field]: value } };
      const source = fakePages([body]);
      await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Malformed/);
    });
  }
}

for (const field of ['page', 'pageSize']) {
  test(`rejects zero ${field}`, async () => {
    const source = fakePages([catalogBody({ [field]: 0 })]);
    await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Malformed/);
  });
}

test('rejects pageSize beyond the requested limit', async () => {
  const source = fakePages([catalogBody({ pageSize: 101 })]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Malformed/);
});

test('fails closed above the original 100-product approval scope', async () => {
  const source = fakePages([catalogBody({ total: 101 })]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /100/);
  assert.equal(source.calls.length, 1);
});

test('fails closed when completing the snapshot would need more than 10 pages', async () => {
  const source = fakePages([catalogBody({ total: 11, pageSize: 1 })]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /10 pages/);
  assert.equal(source.calls.length, 1);
});

/** @type {[string, Partial<CatalogPage>, RegExp][]} */
const secondPageFailures = [
  ['changed total', { total: 89 }, /total changed/],
  ['changed pageSize', { pageSize: 47 }, /pageSize changed/],
  ['repeated page', { page: 1 }, /Unexpected.*page/],
  ['skipped page', { page: 3 }, /Unexpected.*page/],
  ['missing page', { page: undefined }, /Malformed/],
  ['empty incomplete page', { items: [] }, /Incomplete/],
];
for (const [label, overrides, message] of secondPageFailures) {
  test(`rejects ${label} on page 2`, async () => {
    const pages = catalogPages(productIds(90), 48);
    const source = fakePages([pages[0], { ok: true, data: { ...pages[1].data, ...overrides } }]);
    await assert.rejects(publicCatalogSnapshot(source.fetchPage), message);
    assert.equal(source.calls.length, 2);
  });
}

test('rejects an unexpected initial page', async () => {
  const source = fakePages([catalogBody({ page: 2 })]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Unexpected.*page/);
});

test('rejects duplicates within a page', async () => {
  const source = fakePages([catalogBody({ total: 2, items: [{ _id: 'same' }, { _id: 'same' }] })]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Duplicate/);
});

test('rejects duplicate IDs across pages instead of deduplicating silently', async () => {
  const pages = catalogPages(productIds(90), 48);
  pages[1].data.items[0] = pages[0].data.items[0];
  const source = fakePages(pages);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Duplicate/);
});

test('rejects a short non-final page instead of skipping missing products', async () => {
  const pages = catalogPages(productIds(90), 48);
  pages[0].data.items.pop();
  const source = fakePages([pages[0]]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Incomplete/);
});

test('rejects an incomplete final page instead of returning a partial snapshot', async () => {
  const pages = catalogPages(productIds(90), 48);
  pages[1].data.items.pop();
  const source = fakePages(pages);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Incomplete/);
});

test('rejects more items than the effective pageSize', async () => {
  const pages = catalogPages(productIds(90), 48);
  pages[0].data.items.push({ _id: 'extra' });
  const source = fakePages([pages[0]]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Excess/);
});

test('rejects more collected records than total', async () => {
  const pages = catalogPages(productIds(90), 48);
  pages[1].data.items.push({ _id: 'extra' });
  const source = fakePages(pages);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Excess/);
});

test('rejects records when total is zero', async () => {
  const source = fakePages([catalogBody({ total: 0 })]);
  await assert.rejects(publicCatalogSnapshot(source.fetchPage), /Excess/);
});

for (const failurePage of [1, 2]) {
  test(`rejects non-OK HTTP on page ${failurePage} before decoding its body`, async () => {
    const pages = catalogPages(productIds(90), 48);
    await assert.rejects(
      publicCatalogSnapshot(async (page) =>
        responseFor(
          pages[page - 1],
          page === failurePage
            ? { ok: () => false, json: async () => assert.fail('must not decode failed response') }
            : {},
        ),
      ),
      /HTTP/,
    );
  });
}

test('propagates invalid JSON and transport failures without returning a partial result', async () => {
  const pages = catalogPages(productIds(90), 48);
  for (const failure of ['json', 'transport']) {
    await assert.rejects(
      publicCatalogSnapshot(async (page) => {
        if (page === 1) return responseFor(pages[0]);
        if (failure === 'transport') throw new Error('transport failed');
        return responseFor(undefined, {
          json: async () => {
            throw new Error('json failed');
          },
        });
      }),
      new RegExp(`${failure} failed`),
    );
  }
});
