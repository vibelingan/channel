import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { isChatTurnV2 } from '@vibelingan-channel/ai-contracts';
import type { InternalInquirySubmission } from '@vibelingan-channel/ai-contracts/inquiry';
import { AiStore, migrateUp } from '@vibelingan-channel/ai-store';
import { createAiBffServer } from './server.ts';
const saved: InternalInquirySubmission[] = [];
const url = process.env.DATABASE_URL;
const Store = process.env.AI_TEST_STORE_MODULE
  ? ((await import(process.env.AI_TEST_STORE_MODULE)).AiStore as typeof AiStore)
  : AiStore;
const store = url ? new Store(url) : null;
const server = store
  ? createAiBffServer(
      store,
      {
        allowedOrigins: new Set(['http://127.0.0.1:62058']),
        credentialTtlSeconds: 600,
        engineId: 'fake',
        engineVersion: '0.1.0',
        globalRequestsPerMinute: 10000,
        ipRequestsPerMinute: 10000,
        ipHashSecret: randomUUID(),
        trustProxy: false,
        ssePollMs: 2,
        sseHeartbeatMs: 10,
        sseMaxDurationMs: 40,
      },
      {
        inquiryClient: {
          async submit(input) {
            saved.push(input);
            return {
              schemaVersion: '1',
              conversationId: input.conversationId,
              submissionKey: input.submission.submissionKey,
              reference: `ai_${'a'.repeat(64)}`,
              submittedAt: new Date().toISOString(),
            };
          },
        },
      },
    )
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
const skip = !url;
async function conversation() {
  const r = await fetch(`${base}/api/ai/v2/conversations`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 201);
  return (await r.json()) as { conversationId: string; credential: string };
}
async function readTurn(response: Response) {
  const data: unknown = await response.json();
  assert.ok(isChatTurnV2(data));
  assert.ok(data.runId);
  assert.ok(data.controlVersion !== null);
  return { ...data, runId: data.runId, controlVersion: data.controlVersion };
}
function request(c: { conversationId: string; credential: string }, path: string, body?: unknown) {
  return fetch(`${base}/api/ai/v2/conversations/${c.conversationId}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${c.credential}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test(
  'v2 creates a real scoped turn and rejects changed replays and parallel new questions',
  { skip },
  async () => {
    const c = await conversation();
    const key = randomUUID();
    const r = await request(c, 'messages', { message: 'First question', idempotencyKey: key });
    assert.equal(r.status, 202);
    const state = await readTurn(await request(c, `turns/${key}`));
    assert.equal(state.status, 'creating');
    assert.equal(state.operationKey, key);
    assert.ok(state.runId);
    const repeated = await request(c, 'messages', {
      message: 'First question',
      idempotencyKey: key,
    });
    assert.equal(repeated.status, 200);
    assert.equal((await readTurn(repeated)).runId, state.runId);
    assert.equal(
      (await request(c, 'messages', { message: 'Changed question', idempotencyKey: key })).status,
      409,
    );
    assert.equal(
      (await request(c, 'messages', { message: 'Another question', idempotencyKey: randomUUID() }))
        .status,
      409,
    );
    const foreign = await conversation();
    assert.equal(
      (await request({ ...foreign, conversationId: c.conversationId }, `turns/${key}`)).status,
      401,
    );
  },
);
test(
  'cancel is task-bound, repeated requests enqueue once, an old click cannot cancel the next run',
  { skip },
  async () => {
    assert.ok(store);
    const c = await conversation();
    const key = randomUUID();
    await request(c, 'messages', { message: 'Stop this one', idempotencyKey: key });
    const state = await readTurn(await request(c, `turns/${key}`));
    assert.equal(
      (
        await request(c, `turns/${key}/cancel`, {
          runId: randomUUID(),
          controlVersion: state.controlVersion,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(c, `turns/${key}/cancel`, {
          runId: state.runId,
          controlVersion: state.controlVersion + 1,
        })
      ).status,
      409,
    );
    const body = { runId: state.runId, controlVersion: state.controlVersion };
    assert.equal((await request(c, `turns/${key}/cancel`, body)).status, 202);
    assert.equal((await request(c, `turns/${key}/cancel`, body)).status, 202);
    const count = await store.pool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE run_id=$1 AND type='cancel_run'",
      [state.runId],
    );
    assert.equal(count.rows[0].n, 1);
    await store.terminalizeRun({ runId: state.runId, reason: 'cancel_requested' });
    assert.equal(
      (
        await request(c, `turns/${key}/cancel`, {
          ...body,
          controlVersion: body.controlVersion + 1,
        })
      ).status,
      409,
    );
    const next = randomUUID();
    const accepted = await request(c, 'messages', {
      message: 'Next question',
      idempotencyKey: next,
    });
    assert.equal(accepted.status, 202);
    await request(c, `turns/${key}/cancel`, body);
    const current = await readTurn(await request(c, `turns/${next}`));
    assert.equal(current.cancelRequested, false);
    assert.equal(current.status, 'creating');
  },
);
test('v2 streams only the selected run with durable identity', { skip }, async () => {
  assert.ok(store);
  const c = await conversation();
  const previous = randomUUID();
  await request(c, 'messages', { message: 'An earlier answer', idempotencyKey: previous });
  const old = await readTurn(await request(c, `turns/${previous}`));
  await request(c, `turns/${previous}/cancel`, {
    runId: old.runId,
    controlVersion: old.controlVersion,
  });
  await store.terminalizeRun({ runId: old.runId, reason: 'cancel_requested' });
  const key = randomUUID();
  await request(c, 'messages', { message: 'Read this run', idempotencyKey: key });
  const state = await readTurn(await request(c, `turns/${key}`));
  await request(c, `turns/${key}/cancel`, {
    runId: state.runId,
    controlVersion: state.controlVersion,
  });
  await store.terminalizeRun({ runId: state.runId, reason: 'cancel_requested' });
  const r = await request(c, `events?turn=${key}`);
  assert.equal(r.status, 200);
  const stream = await r.text();
  assert.equal(stream.split('\n').filter((line) => line.startsWith('data: ')).length, 1);
  const line = stream.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(line);
  const event = JSON.parse(line.slice(6));
  const recorded = (await store.listEvents(c.conversationId)).find(
    (row) => row.runId === state.runId,
  );
  assert.ok(recorded);
  assert.equal(event.sequence, recorded.sequence);
  assert.equal(event.runId, state.runId);
  assert.equal(event.messageId, state.messageId);
  assert.equal(event.conversationId, c.conversationId);
  assert.equal(event.protocolVersion, 2);
  assert.equal(event.type, 'assistant.cancelled');
  assert.equal((await request(c, 'events')).status, 400);
});

test(
  'v2 validates typed actions and projects only public card fields; v1 stays text-only',
  { skip },
  async () => {
    assert.ok(store);
    const c = await conversation();
    assert.equal(
      (
        await request(c, 'messages', {
          message: 'Read',
          idempotencyKey: randomUUID(),
          catalogAction: { kind: 'lookup', ids: ['bad/path'] },
        })
      ).status,
      400,
    );
    const key = randomUUID();
    const action = { kind: 'lookup', ids: ['p1'] };
    const response = await request(c, 'messages', {
      message: 'Read',
      idempotencyKey: key,
      catalogAction: action,
    });
    const state = await readTurn(response);
    assert.equal(
      (
        await request(c, 'messages', {
          message: 'Read',
          idempotencyKey: key,
          catalogAction: { kind: 'lookup', ids: ['p2'] },
        })
      ).status,
      409,
    );
    const claim = await store.claimRun(state.runId);
    assert.ok(claim);
    await store.finishRunFenced({
      conversationId: c.conversationId,
      runId: state.runId,
      expectedControlVersion: state.controlVersion,
      claimEpoch: claim.claimEpoch,
      status: 'completed',
      events: [
        {
          type: 'final',
          payload: {
            text: 'Current product',
            kind: 'product_updated',
            products: [
              {
                id: 'p1',
                name: 'Public headphones',
                summary: 'Published',
                revision: 'v1',
                href: '/products/item/?id=p1',
                privateNote: 'SECRET_NEVER_PROJECT',
              },
            ],
            unavailableProductIds: [],
          },
        },
      ],
    });
    const stream = await (await request(c, `events?turn=${key}`)).text();
    assert.ok(stream.includes('Public headphones'));
    assert.ok(stream.includes('product_updated'));
    assert.equal(stream.includes('SECRET_NEVER_PROJECT'), false);
    const v1 = await fetch(`${base}/api/ai/conversations/${c.conversationId}/events`, {
      headers: { Authorization: `Bearer ${c.credential}` },
    });
    const legacy = await v1.text();
    assert.ok(legacy.includes('Current product'));
    assert.equal(legacy.includes('products'), false);
    const rejected = await fetch(`${base}/api/ai/conversations/${c.conversationId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Read',
        idempotencyKey: randomUUID(),
        catalogAction: action,
      }),
    });
    assert.equal(rejected.status, 400);
  },
);

test(
  'inquiry submission is credential scoped, confirmed and kept out of model history',
  { skip },
  async () => {
    const c = await conversation();
    const submission = {
      submissionKey: randomUUID(),
      requirement: '500 headphones',
      name: 'Buyer',
      email: 'buyer@example.invalid',
      company: '',
      consent: true,
      consentVersion: 'inquiry-contact-v1',
    };
    const n = saved.length;
    const foreign = await conversation();
    assert.equal(
      (await request({ ...c, credential: foreign.credential }, 'inquiries', submission)).status,
      401,
    );
    assert.equal((await request(c, 'inquiries', { ...submission, consent: false })).status, 400);
    assert.equal((await request(c, 'inquiries', { ...submission, client_id: 'b' })).status, 400);
    assert.equal(saved.length, n);
    const r = await request(c, 'inquiries', submission);
    assert.equal(r.status, 200);
    const receipt = (await r.json()) as { conversationId: string; submissionKey: string };
    assert.equal(receipt.conversationId, c.conversationId);
    assert.equal(receipt.submissionKey, submission.submissionKey);
    assert.equal(saved.at(-1)?.conversationId, c.conversationId);
    assert.ok(store);
    const messages = await store.pool.query(
      'SELECT content FROM conversation_messages WHERE conversation_id=$1',
      [c.conversationId],
    );
    assert.equal(messages.rows.length, 0);
  },
);
