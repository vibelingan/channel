/**
 * The worker must ride out a database or knowledge-base outage instead of
 * exiting: CloudRun would only restart it into the same outage. It must still
 * stop on a mistake, because a worker that waits forever on a wrong setting
 * looks alive while answering nobody.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { EngineError } from '@vibelingan-channel/ai-engine/errors';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import { AiStore } from '@vibelingan-channel/ai-store';
import {
  KB_EVIDENCE_MAX_AGE_MS_DEFAULT,
  createWorkerHealthServer,
  isRetryableStartupError,
  runWorkerLoop,
} from './worker.ts';

type Outcome = 'idle' | 'processed' | Error;

function refused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 10.42.20.3:5432'), {
    code: 'ECONNREFUSED',
  });
}

async function runScripted(outcomes: Outcome[]) {
  const delays: number[] = [];
  const failures: boolean[] = [];
  let iterations = 0;
  await runWorkerLoop({
    step: async () => {
      const next = outcomes[iterations];
      iterations += 1;
      if (next instanceof Error) throw next;
      return next ?? 'idle';
    },
    pollMs: 10,
    shouldStop: () => iterations >= outcomes.length,
    sleep: async (ms) => {
      delays.push(ms);
    },
    onError: (_error, databaseUnavailable) => {
      failures.push(databaseUnavailable);
    },
  });
  return { delays, failures, iterations };
}

test('the worker loop waits out a database outage instead of exiting', async () => {
  const { delays, failures, iterations } = await runScripted([refused(), refused(), 'idle']);
  assert.equal(iterations, 3);
  assert.deepEqual(failures, [true, true]);
  assert.ok((delays[1] ?? 0) > (delays[0] ?? 0), `back-off should grow: ${delays.join(', ')}`);
});

test('a successful iteration starts the back-off over', async () => {
  const { delays } = await runScripted([refused(), refused(), 'processed', refused()]);
  // Two failures, a real job (no pause after real work), then a failure again.
  assert.equal(delays.length, 3);
  assert.equal(delays[2], delays[0]);
});

test('an unexpected error is logged and retried, never thrown out of the loop', async () => {
  const { failures, iterations } = await runScripted([new Error('boom'), 'idle']);
  assert.equal(iterations, 2);
  assert.deepEqual(failures, [false]);
});

test('readiness says starting until startup finishes, and liveness answers throughout', async () => {
  const store = new AiStore('postgres://nobody:nothing@127.0.0.1:1/none', 1);
  let started = false;
  const server = createWorkerHealthServer(store, new FakeEngine(), { isStarted: () => started });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const starting = await fetch(`${base}/readyz`);
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), { status: 'starting' });

    started = true;
    const unreachable = await fetch(`${base}/readyz`);
    assert.equal(unreachable.status, 503, 'the database is unreachable, so still not ready');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  }
});

test('startup waits out an unreachable knowledge base or database, but not a mistake', () => {
  assert.equal(isRetryableStartupError(new EngineError('unavailable')), true);
  assert.equal(isRetryableStartupError(new EngineError('transient')), true);
  assert.equal(isRetryableStartupError(new EngineError('timeout')), true);
  assert.equal(isRetryableStartupError(new TypeError('fetch failed')), true);
  assert.equal(isRetryableStartupError(refused()), true);

  assert.equal(isRetryableStartupError(new EngineError('invalid_request')), false);
  assert.equal(
    isRetryableStartupError(new Error('refusing to serve; knowledge evidence is not acceptable')),
    false,
  );
});

test('knowledge-base evidence is accepted for up to 30 days by default', () => {
  // Every deploy records fresh evidence; 30 days covers a restart long after one.
  assert.equal(KB_EVIDENCE_MAX_AGE_MS_DEFAULT, 30 * 24 * 60 * 60 * 1000);
});
