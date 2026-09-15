/**
 * A database that is restarting, failing over or briefly unreachable must make
 * the AI services wait, not exit. These helpers decide which failures are worth
 * waiting out: a connection refused or cut off is; a wrong password, a missing
 * certificate or a broken query is a mistake that retrying would only hide.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseUnavailable, waitForDatabase } from './resilience.ts';
import { AiStore } from './store.ts';

const databaseUrl = process.env.DATABASE_URL;

function errorWith(code: string, message = 'database error'): Error {
  return Object.assign(new Error(message), { code });
}

test('connection-level failures count as the database being unavailable', () => {
  const codes = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    '08001',
    '08006',
    '57P01',
    '57P03',
    '53300',
  ];
  for (const code of codes) {
    assert.equal(isDatabaseUnavailable(errorWith(code)), true, code);
  }
  assert.equal(isDatabaseUnavailable(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isDatabaseUnavailable(new Error('timeout exceeded when trying to connect')), true);
  assert.equal(
    isDatabaseUnavailable(new AggregateError([errorWith('ECONNREFUSED')], 'connect failed')),
    true,
  );
});

test('query, permission and configuration errors are not waited out', () => {
  for (const code of ['42601', '23505', '28P01', '3D000', '42501', 'ENOENT']) {
    assert.equal(isDatabaseUnavailable(errorWith(code)), false, code);
  }
  assert.equal(isDatabaseUnavailable(new Error('boom')), false);
  assert.equal(isDatabaseUnavailable('ECONNREFUSED'), false);
  assert.equal(isDatabaseUnavailable(undefined), false);
});

test('waitForDatabase keeps waiting while the database refuses connections', async () => {
  // Port 1 refuses immediately on every host, so this needs no database.
  const store = new AiStore('postgres://nobody:nothing@127.0.0.1:1/none', 1);
  const controller = new AbortController();
  const attempts: number[] = [];
  try {
    await assert.rejects(
      waitForDatabase(store, {
        delaysMs: [5],
        signal: controller.signal,
        onRetry: (attempt) => {
          attempts.push(attempt);
          if (attempts.length === 3) controller.abort();
        },
      }),
      /abort/i,
    );
    assert.deepEqual(attempts, [1, 2, 3]);
  } finally {
    await store.close();
  }
});

test('waitForDatabase stops at once on a mistake retrying cannot fix', async () => {
  // A certificate file that does not exist is a deployment mistake. Waiting
  // would hide it behind a service that never becomes ready.
  const store = new AiStore(
    'postgres://nobody:nothing@127.0.0.1:1/none?sslmode=verify-full&sslrootcert=/nonexistent/ca.crt',
    1,
  );
  let retries = 0;
  try {
    await assert.rejects(
      waitForDatabase(store, {
        delaysMs: [5],
        onRetry: () => {
          retries += 1;
        },
      }),
      (error: unknown) => !isDatabaseUnavailable(error),
    );
    assert.equal(retries, 0);
  } finally {
    await store.close();
  }
});

test(
  'waitForDatabase returns once the database answers',
  { skip: databaseUrl ? false : 'DATABASE_URL is required' },
  async () => {
    assert.ok(databaseUrl);
    const store = new AiStore(databaseUrl, 1);
    try {
      await waitForDatabase(store, { delaysMs: [5] });
      assert.equal((await store.health()).database, 'live');
    } finally {
      await store.close();
    }
  },
);
