import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReadyRows,
  countOutcomes,
  planAll,
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
