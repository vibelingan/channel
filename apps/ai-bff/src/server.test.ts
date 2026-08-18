import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { buildServer } from './server.ts';

const config = {
  port: 0,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ai:ai@localhost:55432/ai_assistant',
  corsAllowedOrigins: ['https://allowed.example'],
};

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { server, pool } = buildServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
}

test('liveness answers without touching the database', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('readiness proves a transaction and the isolation level, not just a connection', async () => {
  // `select 1` also succeeds against a read-only replica and against a role
  // that cannot open a transaction. LLD-001's fence needs both, so readiness
  // reports what it actually established — and the deployed environment's
  // isolation level is a property of the managed database, not of our code,
  // which is exactly why it is worth reading back from a running instance.
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/readyz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      store: 'live',
      txn: 'proven',
      isolation: 'read committed',
    });
  });
});

test('readiness reports 503, not 200, when the store is unreachable', async () => {
  const { server, pool } = buildServer({
    ...config,
    databaseUrl: 'postgres://ai:ai@127.0.0.1:1/nope',
  });
  pool.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/readyz`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, store: 'unavailable' });
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
});

test('readiness output carries no host, path, or credential', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/ai/readyz`)).text();
    assert.ok(!/postgres:\/\//.test(body), 'readiness leaked a connection string');
    assert.ok(!/(password|secret|token)/i.test(body), 'readiness looks credential-shaped');
  });
});

test('an allowed origin gets CORS headers; an unlisted one gets none', async () => {
  await withServer(async (base) => {
    const ok = await fetch(`${base}/api/ai/healthz`, {
      headers: { origin: 'https://allowed.example' },
    });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal(ok.headers.get('vary'), 'origin');

    const denied = await fetch(`${base}/api/ai/healthz`, {
      headers: { origin: 'https://evil.example' },
    });
    // Not an error status — the browser enforces CORS. The server's job is to
    // withhold the header, and reflecting the origin back is the actual bug.
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});

test('preflight is answered for an allowed origin', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/healthz`, {
      method: 'OPTIONS',
      headers: { origin: 'https://allowed.example' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  });
});

test('unknown routes return the shared error envelope', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});
