import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCatalog, auditCatalog, verifyPage } from './catalog-price-repair.mjs';

function result(mode, offset, count) {
  const outcomes = Array.from({ length: count }, (_, index) => ({
    productId: `p-${String(offset + index).padStart(3, '0')}`,
    status: mode === 'apply' ? 'repaired' : 'eligible',
  }));
  return {
    mode,
    visited: count,
    eligible: count,
    repaired: mode === 'apply' ? count : 0,
    deferred: [],
    nextId: count === 20 ? outcomes.at(-1).productId : null,
    pageHash: 'a'.repeat(64),
    stopped: null,
    outcomes,
  };
}
const fresh = () => ({ status: 'collecting', pages: [], nextApplyIndex: 0 });

test('audit persists each bounded page and covers 120 records plus terminal empty page', async () => {
  const saved = [];
  const manifest = fresh();
  let offset = 0;
  await auditCatalog(
    async () => {
      const page = result('dry-run', offset, offset < 120 ? 20 : 0);
      offset += 20;
      return page;
    },
    async (m) => saved.push(structuredClone(m)),
    manifest,
  );
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.pages.length, 7);
  assert.equal(saved.length, 7);
  assert.equal(manifest.pages.flatMap((page) => page.result.outcomes).length, 120);
});

test('a failed audit page retains the prior checkpoint and resumes at its cursor', async () => {
  const manifest = fresh();
  let calls = 0;
  const saved = [];
  await assert.rejects(
    auditCatalog(
      async () => {
        if (calls++) throw Error('network');
        return result('dry-run', 0, 20);
      },
      async (m) => saved.push(structuredClone(m)),
      manifest,
    ),
    /network/,
  );
  assert.equal(saved.at(-1).pages.length, 1);
  await auditCatalog(
    async (input) => {
      assert.equal(input.afterId, 'p-019');
      return result('dry-run', 20, 1);
    },
    async () => {},
    manifest,
  );
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.pages.length, 2);
});

test('apply verifies every repaired record before checkpointing and stops on stale input', async () => {
  const manifest = {
    status: 'ready',
    pages: [{ afterId: null, result: result('dry-run', 0, 1) }],
    nextApplyIndex: 0,
  };
  await assert.rejects(
    applyCatalog(
      async () => ({ ...result('apply', 0, 1), stopped: 'page-changed' }),
      async () => {},
      manifest,
      async () => {},
    ),
    /page-changed/,
  );
  assert.equal(manifest.nextApplyIndex, 0);
  const verified = [];
  await applyCatalog(
    async (input) => {
      assert.equal(input.expectedPageHash, 'a'.repeat(64));
      return result('apply', 0, 1);
    },
    async () => {},
    manifest,
    async (row) => verified.push(row.productId),
  );
  assert.deepEqual(verified, ['p-000']);
  assert.equal(manifest.nextApplyIndex, 1);
  assert.equal(manifest.status, 'applied');
});

test('lost acknowledgement and failed public verification cannot advance apply', async () => {
  for (const failure of ['transport', 'verify']) {
    const manifest = {
      status: 'ready',
      pages: [{ afterId: null, result: result('dry-run', 0, 1) }],
      nextApplyIndex: 0,
    };
    await assert.rejects(
      applyCatalog(
        async () => {
          if (failure === 'transport') throw Error('transport');
          return result('apply', 0, 1);
        },
        async () => {},
        manifest,
        async () => {
          throw Error('verify');
        },
      ),
      new RegExp(failure),
    );
    assert.equal(manifest.nextApplyIndex, 0);
  }
});

test('malformed/duplicate pages and backwards cursors fail closed', () => {
  const base = result('dry-run', 0, 20);
  for (const page of [
    { ...base, visited: 21 },
    { ...base, repaired: 1 },
    { ...base, nextId: 'wrong' },
    { ...base, outcomes: Array(20).fill(base.outcomes[0]) },
  ])
    assert.throws(() => verifyPage(page, 'dry-run'), /Unconfirmed/);
  assert.throws(() => verifyPage(base, 'dry-run', 'p-099'), /Unconfirmed/);
});
