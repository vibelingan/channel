import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { AiStore, migrateDown, migrateUp } from '@vibelingan-channel/ai-store';
import { type AiBffConfig, createAiBffServer } from './server.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is required for BFF integration tests';
const store = databaseUrl ? new AiStore(databaseUrl, 10) : null;
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
const server = store ? createAiBffServer(store, config) : null;
let baseUrl = '';

before(async () => {
  if (!store || !server) return;
  await migrateDown(store.pool);
  await migrateUp(store.pool);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  if (!store) return;
  await store.pool.query(
    'TRUNCATE ai_rate_limit_buckets, audit_events, outbox, leads, conversation_events, conversation_messages, engine_run_handles, conversation_credentials, conversations, ai_runs RESTART IDENTITY CASCADE',
  );
});

after(async () => {
  if (!store || !server) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await migrateDown(store.pool);
  await store.close();
});

test('health proves the BFF and READ COMMITTED database contract', { skip }, async () => {
  const response = await fetch(`${baseUrl}/api/ai/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'live',
    database: { database: 'live', isolation: 'read committed' },
    service: 'channel-ai-bff',
  });
});

test('unknown browser origin is rejected before conversation creation', { skip }, async () => {
  const response = await fetch(`${baseUrl}/api/ai/conversations`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
});

test('rate-limit storage pseudonymizes a trusted proxy client address', { skip }, async () => {
  assert.ok(store);
  const rawAddress = '203.0.113.42';
  const response = await fetch(`${baseUrl}/api/ai/conversations`, {
    method: 'POST',
    headers: {
      origin: 'https://site.example',
      'content-type': 'application/json',
      'x-forwarded-for': rawAddress,
    },
    body: '{}',
  });
  assert.equal(response.status, 201);
  const buckets = await store.pool.query<{ bucket_key: string }>(
    `SELECT bucket_key FROM ai_rate_limit_buckets WHERE bucket_key LIKE 'ip:%'`,
  );
  assert.equal(buckets.rows.length, 1);
  assert.doesNotMatch(buckets.rows[0]?.bucket_key ?? '', /203\.0\.113\.42/);
  assert.match(buckets.rows[0]?.bucket_key ?? '', /^ip:[a-f0-9]{64}$/);
});

test(
  'credential is scoped to one conversation and message replay is idempotent',
  { skip },
  async () => {
    const first = await createConversation();
    const second = await createConversation();
    const append = () =>
      fetch(`${baseUrl}/api/ai/conversations/${first.conversationId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${first.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'What is your MOQ?', idempotencyKey: 'message-0001' }),
      });
    const accepted = await append();
    const replay = await append();
    assert.equal(accepted.status, 202);
    assert.equal(replay.status, 200);
    assert.equal(((await accepted.json()) as { disposition: string }).disposition, 'started');
    assert.equal(((await replay.json()) as { disposition: string }).disposition, 'replayed');

    const crossScope = await fetch(
      `${baseUrl}/api/ai/conversations/${second.conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${first.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'cross scope', idempotencyKey: 'message-0002' }),
      },
    );
    assert.equal(crossScope.status, 401);
  },
);

test('SSE Last-Event-ID resumes with no duplicate committed event', { skip }, async () => {
  assert.ok(store);
  const created = await createConversation();
  const acceptedResponse = await fetch(
    `${baseUrl}/api/ai/conversations/${created.conversationId}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'hello', idempotencyKey: 'message-sse1' }),
    },
  );
  const accepted = (await acceptedResponse.json()) as { runId: string };
  const claim = await store.claimRun(accepted.runId);
  assert.ok(claim);
  await store.appendEventFenced({
    conversationId: created.conversationId,
    runId: accepted.runId,
    expectedControlVersion: claim.controlVersion,
    claimEpoch: claim.claimEpoch,
    type: 'token',
    payload: { text: 'one' },
  });
  await store.appendEventFenced({
    conversationId: created.conversationId,
    runId: accepted.runId,
    expectedControlVersion: claim.controlVersion,
    claimEpoch: claim.claimEpoch,
    type: 'token',
    payload: { text: 'two' },
  });

  const response = await fetch(`${baseUrl}/api/ai/conversations/${created.conversationId}/events`, {
    headers: { authorization: `Bearer ${created.credential}`, 'last-event-id': '1' },
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /data: .*"one"/);
  assert.match(body, /id: 2\nevent: token\ndata: .*"two"/);
});

async function createConversation(): Promise<{ conversationId: string; credential: string }> {
  const response = await fetch(`${baseUrl}/api/ai/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://site.example' },
    body: '{}',
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ conversationId: string; credential: string }>;
}
