import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { buildWorker, loadWorkerConfig } from './worker.ts';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ai:ai@localhost:55432/ai_assistant';

test('refuses to start without a database url', () => {
  assert.throws(() => loadWorkerConfig({ DATABASE_URL: '' }), /DATABASE_URL/);
});

test('readiness reports the store when reachable, and leaks nothing', async () => {
  const { server, pool } = buildWorker({ databaseUrl, port: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /"store":"live"/);
    // Same reasoning as the BFF: a reachable store is not a usable one.
    assert.match(body, /"txn":"proven"/);
    assert.match(body, /"isolation":"read committed"/);
    assert.ok(!/postgres:\/\//.test(body), 'readiness leaked a connection string');
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
});
