import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createAiPool } from './pool.ts';
import { createStoreReadiness, proveStore } from './readiness.ts';

const URL = process.env.DATABASE_URL ?? 'postgres://ai:ai@localhost:55432/ai_assistant';

test('the proof exercises a real transaction and a real rollback', async () => {
  const pool = createAiPool({ connectionString: URL });
  try {
    const proof = await proveStore(pool);
    assert.equal(proof.txn, 'proven');
    assert.equal(proof.isolation, 'read committed');
  } finally {
    await pool.end();
  }
});

test('the proof needs no migration and leaves nothing behind', async () => {
  // Readiness must not depend on application schema, or a fresh environment
  // reports "not ready" for a reason that has nothing to do with the store.
  const pool = createAiPool({ connectionString: URL, max: 2 });
  try {
    await proveStore(pool);
    const left = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_name = 'ai_readiness_probe' and table_schema not like 'pg_temp%'",
    );
    assert.equal(left.rows[0].n, 0, 'the proof left a permanent table behind');
  } finally {
    await pool.end();
  }
});

test('the proof fails, rather than passing quietly, when the store is unreachable', async () => {
  const pool = createAiPool({
    connectionString: 'postgres://ai:ai@127.0.0.1:1/ai_assistant',
    connectionTimeoutMillis: 2_000,
  });
  pool.on('error', () => undefined);
  try {
    await assert.rejects(proveStore(pool));
  } finally {
    await pool.end().catch(() => undefined);
  }
});

test('concurrent readiness checks share one in-flight proof', async () => {
  const pool = createAiPool({ connectionString: URL, max: 2 });
  try {
    const readiness = createStoreReadiness(pool);
    const [a, b] = await Promise.all([readiness.check(), readiness.check()]);
    assert.equal(a, b, 'two callers ran two separate proofs');
  } finally {
    await pool.end();
  }
});

test('a failed proof is retried, not cached as a permanent verdict', async () => {
  // A store that is briefly down at boot must be able to become ready without
  // a restart — otherwise the deploy crash-loops on a transient outage.
  const dead = createAiPool({
    connectionString: 'postgres://ai:ai@127.0.0.1:1/ai_assistant',
    connectionTimeoutMillis: 1_000,
  });
  dead.on('error', () => undefined);
  const readiness = createStoreReadiness(dead);
  await assert.rejects(readiness.check());
  await assert.rejects(readiness.check(), 'the second call short-circuited instead of retrying');
  await dead.end().catch(() => undefined);
});
