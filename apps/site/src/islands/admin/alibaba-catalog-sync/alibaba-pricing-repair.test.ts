import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeAlibabaDrafts, repairAlibabaSourcePricing } from './alibaba-api.ts';

function page(mode: 'dry-run' | 'apply', count: number, nextId: string | null) {
  const outcomes = Array.from({ length: count }, (_, index) => ({
    productId: `product-${String(count === 1 ? 20 : index).padStart(3, '0')}`,
    status: index === 0 ? (mode === 'apply' ? 'repaired' : 'eligible') : 'unlinked',
  }));
  return {
    mode,
    visited: count,
    eligible: count ? 1 : 0,
    repaired: mode === 'apply' && count ? 1 : 0,
    deferred: [],
    nextId,
    pageHash: 'a'.repeat(64),
    stopped: null,
    outcomes,
  };
}

test('pricing repair validates every page, reports progress and uses the confirmed cursor', async (t) => {
  const calls: unknown[] = [];
  const progress: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    calls.push(JSON.parse(String(options.body)).data);
    return new Response(
      JSON.stringify({
        ok: true,
        data: page(
          calls.length % 2 ? 'dry-run' : 'apply',
          calls.length <= 2 ? 20 : 1,
          calls.length <= 2 ? 'product-019' : null,
        ),
      }),
    );
  });
  const result = await repairAlibabaSourcePricing((value) => progress.push(value));
  assert.deepEqual(calls, [
    { mode: 'dry-run' },
    { mode: 'apply', expectedPageHash: 'a'.repeat(64) },
    { afterId: 'product-019', mode: 'dry-run' },
    { afterId: 'product-019', mode: 'apply', expectedPageHash: 'a'.repeat(64) },
  ]);
  assert.equal(progress.length, 2);
  assert.match(result, /21 checked · 2 source quotes repaired · 0 require review/);
});

test('pricing repair rejects inconsistent deferred counts and never sends the next page', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        data: { ...page('dry-run', 1, null), deferred: ['unexpected'] },
      }),
    );
  });
  await assert.rejects(
    repairAlibabaSourcePricing(() => undefined),
    /not confirmed/,
  );
  assert.equal(calls, 1);
});

test('pricing repair stops on a lost response and explains safe manual recovery', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    repairAlibabaSourcePricing(() => undefined),
    /last page may have saved.*restart/i,
  );
  assert.equal(calls, 1);
});

test('draft materialization accepts the new verified pricing outcomes and rejects unknown outcome fields', async (t) => {
  const result = {
    afterSourceKey: '',
    nextSourceKey: 'source-g2',
    done: true,
    visited: 1,
    created: 1,
    existing: 0,
    failures: [],
    pricing: [{ productId: 'g2', status: 'repaired', reason: 'Verified' }],
  };
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ ok: true, data: result })),
  );
  assert.deepEqual(await materializeAlibabaDrafts(), {
    visited: 1,
    created: 1,
    existing: 0,
    failures: 0,
  });
  Object.assign(result.pricing[0], { raw: 'unexpected' });
  await assert.rejects(materializeAlibabaDrafts(), /invalid page summary/);
});
