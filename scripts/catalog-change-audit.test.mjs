import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAuditRows, auditRowsToApply, summarize } from './catalog-change-audit.mjs';

const rows = [
  { productId: 'a', revision: 'r1', outcome: 'unchanged', sourceDigest: 'd'.repeat(64) },
  {
    productId: 'b',
    revision: 'r1',
    outcome: 'changed',
    sourceDigest: 'e'.repeat(64),
    differences: ['description'],
  },
  { productId: 'c', outcome: 'skipped', reason: 'not-approved' },
];

test('only reviewed outcomes are sent, without the digest or differences', () => {
  assert.deepEqual(auditRowsToApply(rows), [
    { productId: 'a', revision: 'r1', outcome: 'unchanged' },
    { productId: 'b', revision: 'r1', outcome: 'changed' },
  ]);
});

test('the plan summary lists what differs on each changed product', () => {
  assert.deepEqual(summarize(rows), {
    unchanged: 1,
    changed: [{ productId: 'b', differences: ['description'] }],
    skipped: 1,
  });
});

test('apply batches by 20 and keeps confirmed rows when a later batch fails', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    productId: `p${i}`,
    revision: 'r1',
    outcome: 'unchanged',
  }));
  let calls = 0;
  const error = await applyAuditRows(async (data) => {
    calls++;
    if (calls === 2) throw new Error('API call unconfirmed (503, unknown).');
    return {
      results: data.rows.map((row) => ({
        productId: row.productId,
        result: { ok: true, backfill: 'applied' },
      })),
    };
  }, many).catch((caught) => caught);
  assert.match(error.message, /20 rows were confirmed/);
  assert.equal(error.results.length, 20);
});

test('a short or refused response is never taken as complete', async () => {
  const short = await applyAuditRows(async () => ({ results: [] }), rows).catch((caught) => caught);
  assert.match(short.message, /Unconfirmed apply response/);
  const refused = await applyAuditRows(
    async (data) => ({
      results: data.rows.map((row) => ({
        productId: row.productId,
        result:
          row.productId === 'b'
            ? { ok: false, code: 'FORBIDDEN' }
            : { ok: true, backfill: 'applied' },
      })),
    }),
    rows,
  ).catch((caught) => caught);
  assert.match(refused.message, /b: FORBIDDEN/);
  assert.deepEqual(
    refused.results.map((item) => item.productId),
    ['a'],
  );
});
