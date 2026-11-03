import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { AiStore, migrateUp } from '@vibelingan-channel/ai-store';
import {
  MAX_QUESTION_CHARS,
  type QuestionLimits,
  createAiBffServer,
  questionWait,
} from './server.ts';

const limits = (overrides: Partial<QuestionLimits> = {}): QuestionLimits => ({
  perConversationPerMinute: 1000,
  perConversationPerDay: 1000,
  perIpPerDay: 1000,
  refusalsBeforeCooldown: 1000,
  cooldownSeconds: 600,
  ...overrides,
});

/** Buckets that never roll over, so a test cannot straddle a window edge. */
function bucketStore(idle = { streak: 0 }) {
  const hits = new Map<string, number>();
  return {
    hits,
    idle,
    async idleAnswerStreak(_conversationId: string, limit: number) {
      return Math.min(idle.streak, limit);
    },
    async reserveRateLimit(input: { bucketKey: string; windowSeconds: number; limit: number }) {
      const now = hits.get(input.bucketKey) ?? 0;
      if (now >= input.limit) return { allowed: false, remaining: 0 };
      hits.set(input.bucketKey, now + 1);
      return { allowed: true, remaining: input.limit - now - 1 };
    },
    async rateLimitHits(bucketKey: string) {
      return hits.get(bucketKey) ?? 0;
    },
  };
}

test('a conversation may ask a few questions a minute, then waits for the minute to end', async () => {
  const store = bucketStore();
  const rules = limits({ perConversationPerMinute: 2 });
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  const wait = await questionWait(store, rules, 'c1', 'ip');
  assert.equal(wait?.rule, 'conversation_minute');
  assert.ok(wait && wait.seconds >= 1 && wait.seconds <= 60);
  // Another conversation is counted on its own.
  assert.equal(await questionWait(store, rules, 'c2', 'ip'), null);
});

test('after a run of idle answers, questions share a small hourly allowance until one is not idle', async () => {
  const idle = { streak: 4 };
  const store = bucketStore(idle);
  const rules = limits({ idleRepliesBeforeSlowdown: 5, idleQuestionsPerHour: 2 });
  // Four small-talk replies in a row change nothing.
  for (let i = 0; i < 5; i++) assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  assert.equal(store.hits.get('questions:c1:idle-hour'), undefined);
  idle.streak = 5;
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  const wait = await questionWait(store, rules, 'c1', 'ip');
  assert.equal(wait?.rule, 'idle_hour');
  assert.ok(wait && wait.seconds >= 1 && wait.seconds <= 3_600);
  // A real answer ends the streak, and with it the allowance.
  idle.streak = 0;
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  // Not configured: no allowance at all.
  idle.streak = 50;
  assert.equal(await questionWait(store, limits(), 'c2', 'ip'), null);
});

test('daily limits apply per conversation and per visitor address', async () => {
  const store = bucketStore();
  const rules = limits({ perConversationPerDay: 2, perIpPerDay: 3 });
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  const day = await questionWait(store, rules, 'c1', 'ip');
  assert.equal(day?.rule, 'conversation_day');
  assert.ok(day && day.seconds >= 1 && day.seconds <= 86_400);
  // A new conversation from the same address still meets the address limit.
  assert.equal(await questionWait(store, rules, 'c2', 'ip'), null);
  assert.equal((await questionWait(store, rules, 'c3', 'ip'))?.rule, 'ip_day');
  assert.equal(await questionWait(store, rules, 'c4', 'other-ip'), null);
});

test('repeated refusals start a cooldown that only ends with its window', async () => {
  const store = bucketStore();
  const rules = limits({ perConversationPerMinute: 1, refusalsBeforeCooldown: 2 });
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
  assert.equal((await questionWait(store, rules, 'c1', 'ip'))?.rule, 'conversation_minute');
  assert.equal((await questionWait(store, rules, 'c1', 'ip'))?.rule, 'conversation_minute');
  const cooldown = await questionWait(store, rules, 'c1', 'ip');
  assert.equal(cooldown?.rule, 'cooldown');
  assert.ok(cooldown && cooldown.seconds >= 1 && cooldown.seconds <= 600);
  // A cooling conversation is not charged for the questions it is refused.
  const charged = store.hits.get('questions:ip:ip:day');
  await questionWait(store, rules, 'c1', 'ip');
  assert.equal(store.hits.get('questions:ip:ip:day'), charged);
  // The window ending is the whole release: nothing else remembers the refusals.
  store.hits.clear();
  assert.equal(await questionWait(store, rules, 'c1', 'ip'), null);
});

const url = process.env.DATABASE_URL;
const store = url ? new AiStore(url) : null;
const server = store
  ? createAiBffServer(store, {
      allowedOrigins: new Set(['http://127.0.0.1:62058']),
      credentialTtlSeconds: 600,
      engineId: 'fake',
      engineVersion: '0.1.0',
      globalRequestsPerMinute: 10000,
      ipRequestsPerMinute: 10000,
      questionLimits: limits({ perConversationPerDay: 2 }),
      ipHashSecret: randomUUID(),
      trustProxy: false,
      ssePollMs: 2,
      sseHeartbeatMs: 10,
      sseMaxDurationMs: 40,
    })
  : null;
let base = '';
before(async () => {
  if (!store || !server) return;
  await migrateUp(store.pool);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (!store || !server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await store.close();
});
async function conversation() {
  const r = await fetch(`${base}/api/ai/v2/conversations`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 201);
  return (await r.json()) as { conversationId: string; credential: string };
}
function ask(
  c: { conversationId: string; credential: string },
  message: string,
  key = randomUUID(),
) {
  return fetch(`${base}/api/ai/v2/conversations/${c.conversationId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.credential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, idempotencyKey: key }),
  });
}
/** Answer the open turn, as the worker would, so the next question can start. */
async function answer(response: Response) {
  assert.ok(store);
  const { runId, conversationId } = (await response.json()) as {
    runId: string;
    conversationId: string;
  };
  const claim = await store.claimRun(runId);
  assert.ok(claim);
  assert.ok(
    await store.finishRunFenced({
      conversationId,
      runId,
      expectedControlVersion: claim.controlVersion,
      claimEpoch: claim.claimEpoch,
      status: 'completed',
      events: [{ type: 'final', payload: { text: 'Answered.' } }],
    }),
  );
}

test(
  'a limited question is refused with a wait, is not stored, and retries are not charged',
  { skip: !url },
  async () => {
    assert.ok(store);
    const c = await conversation();
    const second = randomUUID();
    await answer(await ask(c, 'First question'));
    const accepted = await ask(c, 'Second question', second);
    assert.equal(accepted.status, 202);
    await answer(accepted);
    // The same submission sent again is a retry, not a third question.
    assert.equal((await ask(c, 'Second question', second)).status, 200);
    const refused = await ask(c, 'Third question');
    assert.equal(refused.status, 429);
    const wait = Number(refused.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= 86_400);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      'RATE_LIMITED',
    );
    const stored = await store.pool.query(
      `SELECT content FROM conversation_messages WHERE conversation_id=$1 AND role='visitor' ORDER BY created_at`,
      [c.conversationId],
    );
    assert.deepEqual(
      stored.rows.map((row) => row.content),
      ['First question', 'Second question'],
    );
    // Another conversation is not affected.
    assert.equal((await ask(await conversation(), 'A new conversation')).status, 202);
  },
);

test('a question longer than the composer allows is refused, not cut', { skip: !url }, async () => {
  const c = await conversation();
  assert.equal((await ask(c, 'x'.repeat(MAX_QUESTION_CHARS + 1))).status, 400);
  assert.equal((await ask(c, `  ${'y'.repeat(MAX_QUESTION_CHARS)}  `)).status, 202);
});
