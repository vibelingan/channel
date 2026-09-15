/**
 * While the database is out, the BFF must say "try again shortly": a 503 with
 * Retry-After. It must never crash, and never answer 500, which tells the
 * visitor, and the platform, that the service itself is broken.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AiStore } from '@vibelingan-channel/ai-store';
import { type AiBffConfig, createAiBffServer } from './server.ts';

const config: AiBffConfig = {
  allowedOrigins: new Set(['https://site.example']),
  credentialTtlSeconds: 60,
  engineId: 'fake',
  engineVersion: '0.1.0',
  globalRequestsPerMinute: 10_000,
  ipRequestsPerMinute: 10_000,
  ipHashSecret: 'test-only-ip-hash-secret-0001',
  trustProxy: true,
  ssePollMs: 5,
  sseHeartbeatMs: 20,
  sseMaxDurationMs: 40,
};

async function serveWithUnreachableDatabase(isReady?: () => boolean) {
  // Port 1 refuses immediately on every host, so this needs no database.
  const store = new AiStore('postgres://nobody:nothing@127.0.0.1:1/none', 1);
  const server = createAiBffServer(store, config, isReady ? { isReady } : {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

function createConversation(base: string) {
  return fetch(`${base}/api/ai/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
  });
}

test('a database outage answers 503 with Retry-After, not a 500', async () => {
  const { base, close } = await serveWithUnreachableDatabase();
  try {
    const response = await createConversation(base);
    assert.equal(response.status, 503);
    assert.ok(
      response.headers.get('retry-after'),
      'Retry-After tells the widget when to try again',
    );
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'UNAVAILABLE');
  } finally {
    await close();
  }
});

test('until startup has reached the database, only liveness answers normally', async () => {
  const { base, close } = await serveWithUnreachableDatabase(() => false);
  try {
    assert.equal((await fetch(`${base}/api/ai/healthz`)).status, 200);

    const readiness = await fetch(`${base}/api/ai/readyz`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { status: 'starting' });

    const response = await createConversation(base);
    assert.equal(response.status, 503);
    assert.ok(response.headers.get('retry-after'));
  } finally {
    await close();
  }
});
