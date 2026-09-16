import assert from 'node:assert/strict';
import test from 'node:test';
import { repairAlibabaSourcePricing } from './alibaba-api.ts';

test('pricing repair validates every page, reports progress and uses the confirmed cursor', async (t) => {
  const calls: unknown[] = [];
  const progress: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    calls.push(JSON.parse(String(options.body)).data);
    return new Response(
      JSON.stringify({
        ok: true,
        data:
          calls.length === 1
            ? { visited: 20, repaired: 2, deferred: ['held'], nextId: 'next' }
            : { visited: 1, repaired: 1, deferred: [], nextId: null },
      }),
    );
  });
  const result = await repairAlibabaSourcePricing((value) => progress.push(value));
  assert.deepEqual(calls, [{}, { afterId: 'next' }]);
  assert.equal(progress.length, 2);
  assert.match(result, /21 checked · 3 source quotes repaired · 1 require/);
});

test('pricing repair rejects inconsistent deferred counts and never sends the next page', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        data: { visited: 1, repaired: 1, deferred: ['unexpected'], nextId: 'cursor' },
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
