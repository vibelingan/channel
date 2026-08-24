import { strict as assert } from 'node:assert';
import { type AddressInfo, connect } from 'node:net';
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

/**
 * The worker had no Host-header test at all — the BFF's (vacuous) one was the
 * only coverage, and it did not exercise this service.
 */
function rawRequest(port: number, path: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let received = '';
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('timed out'));
    });
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
  });
}

test('the worker routes correctly despite a malformed Host header', async () => {
  const { server, pool } = buildWorker({ databaseUrl, port: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    for (const host of ['', ':::::', '[unclosed', '%%%', 'x'.repeat(2000)]) {
      const response = await rawRequest(port, '/healthz', host);
      assert.match(
        response,
        /^HTTP\/1\.1 200/,
        `host ${JSON.stringify(host.slice(0, 20))} did not route: ${response.slice(0, 60)}`,
      );
    }
    const missing = await rawRequest(port, '/nope', '[unclosed');
    assert.match(missing, /^HTTP\/1\.1 404/);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
});
