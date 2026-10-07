import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReadyRows,
  countOutcomes,
  planAll,
  productPriceWithConfigurations,
  tallyResults,
} from './catalog-price-summary-backfill.mjs';

const ready = (id) => ({
  productId: id,
  revision: 'r1',
  outcome: 'ready',
  priceSummary: { source: 'website', pricing: { mode: 'fixed', currency: 'USD', amountMinor: 1 } },
});

test('plan pages through the catalog with afterId and never applies', async () => {
  const calls = [];
  const pages = [
    {
      rows: [ready('a'), { productId: 'b', outcome: 'not-approved' }],
      nextAfterId: 'b',
      done: false,
    },
    {
      rows: [{ productId: 'c', revision: 'r2', outcome: 'already-present' }],
      nextAfterId: 'c',
      done: true,
    },
  ];
  const rows = await planAll(async (data) => {
    calls.push(data);
    return pages.shift();
  });
  assert.deepEqual(calls, [{ mode: 'plan' }, { mode: 'plan', afterId: 'b' }]);
  assert.deepEqual(
    rows.map((row) => row.productId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(countOutcomes(rows), { ready: 1, 'not-approved': 1, 'already-present': 1 });
});

test('apply sends only ready rows, at most 20 per call, without the outcome field', async () => {
  const sent = [];
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => ready(`p${i}`)),
    { productId: 'x', outcome: 'no-price' },
  ];
  const results = await applyReadyRows(async (data) => {
    sent.push(data);
    return {
      results: data.rows.map((row) => ({
        productId: row.productId,
        result: { ok: true, backfill: 'applied' },
      })),
    };
  }, rows);
  assert.deepEqual(
    sent.map((data) => [data.mode, data.rows.length]),
    [
      ['apply', 20],
      ['apply', 5],
    ],
  );
  assert.ok(sent.every((data) => data.rows.every((row) => !('outcome' in row))));
  assert.equal(results.length, 25);
});

test('apply stops when the server reports a row it could not confirm', async () => {
  await assert.rejects(
    applyReadyRows(
      async (data) => ({
        results: data.rows.map((row) => ({
          productId: row.productId,
          result: { ok: false, code: 'CONFLICT' },
        })),
      }),
      [ready('a')],
    ),
    /a: CONFLICT/,
  );
});

test('a run that fails partway still reports the rows it confirmed', async () => {
  let calls = 0;
  const rows = Array.from({ length: 25 }, (_, i) => ready(`p${i}`));
  const error = await applyReadyRows(async (data) => {
    calls++;
    if (calls === 2) throw new Error('API call unconfirmed (503, unknown).');
    return {
      results: data.rows.map((row) => ({
        productId: row.productId,
        result: { ok: true, backfill: 'applied' },
      })),
    };
  }, rows).catch((caught) => caught);
  assert.match(error.message, /503.*20 rows were confirmed/);
  assert.equal(error.results.length, 20);
});

test('apply totals separate applied rows from skipped rows by reason', () => {
  assert.deepEqual(
    tallyResults([
      { productId: 'a', result: { ok: true, backfill: 'applied' } },
      { productId: 'b', result: { ok: true, backfill: 'skipped', reason: 'summary-changed' } },
      { productId: 'c', result: { ok: true, backfill: 'skipped', reason: 'summary-changed' } },
    ]),
    { applied: 1, 'skipped:summary-changed': 2 },
  );
});

test('a batch with one refused row still records every row the server confirmed', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ready(`p${i}`));
  const error = await applyReadyRows(
    async (data) => ({
      results: data.rows.map((row) => ({
        productId: row.productId,
        result:
          row.productId === 'p1'
            ? { ok: false, code: 'CONFLICT' }
            : { ok: true, backfill: 'applied' },
      })),
    }),
    rows,
  ).catch((caught) => caught);
  assert.match(error.message, /p1: CONFLICT/);
  assert.deepEqual(
    error.results.map((item) => item.productId),
    ['p0', 'p2', 'p3', 'p4'],
  );
});

test('a response that answers fewer rows than were sent is not taken as complete', async () => {
  const error = await applyReadyRows(
    async (data) => ({
      results: data.rows.slice(0, 1).map((row) => ({
        productId: row.productId,
        result: { ok: true, backfill: 'applied' },
      })),
    }),
    [ready('a'), ready('b')],
  ).catch((caught) => caught);
  assert.match(error.message, /confirmed 1 of 2 rows/);
  assert.equal(error.results.length, 1);
});

test('the plan lists product-level card prices on products with configurations (R4 review)', () => {
  const productLevel = {
    ...ready('headline'),
    variantCount: 4,
    priceSummary: {
      source: 'product',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: 1 },
    },
  };
  const noConfigurations = { ...productLevel, productId: 'plain', variantCount: 0 };
  assert.deepEqual(
    productPriceWithConfigurations([
      productLevel,
      noConfigurations,
      { ...ready('sku'), variantCount: 2 },
    ]),
    ['headline'],
  );
});

test('the R4 list refuses plan rows without variantCount instead of returning nothing', () => {
  assert.throws(
    () => productPriceWithConfigurations([ready('old-planner')]),
    /old-planner: plan row has no variantCount/,
  );
});

test('a response without a results list keeps the rows confirmed before it', async () => {
  let calls = 0;
  const error = await applyReadyRows(
    async (data) =>
      ++calls === 1
        ? {
            results: data.rows.map((row) => ({
              productId: row.productId,
              result: { ok: true, backfill: 'applied' },
            })),
          }
        : { unexpected: true },
    Array.from({ length: 21 }, (_, i) => ready(`p${i}`)),
  ).catch((caught) => caught);
  assert.match(error.message, /Unconfirmed apply response — 20 rows/);
  assert.equal(error.results.length, 20);
});
