import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import { AiStore, migrateUp } from '@vibelingan-channel/ai-store';
import {
  type WorkerConfig,
  processOne,
  validateWorkerConfig,
  verifyKnowledgeAttestation,
} from './worker.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is required for worker integration tests';
const store = databaseUrl ? new AiStore(databaseUrl, 10) : null;
const config: WorkerConfig = {
  pollMs: 5,
  leaseSeconds: 30,
  maxAttempts: 2,
  profileId: 'channel-public-v1',
  maxDeliveredOutputUnits: 100,
  maxStreamDurationMs: 1_000,
  maxToolCalls: 1,
};

test('worker lease must outlive the longest permitted provider stream', () => {
  assert.throws(
    () => validateWorkerConfig({ ...config, leaseSeconds: 5, maxStreamDurationMs: 1_000 }),
    /must exceed/,
  );
  assert.equal(validateWorkerConfig(config), config);
});

test('worker refuses a knowledge credential whose attested identity drifts', async () => {
  const engine = new FakeEngine();
  const actual = await engine.attestKnowledgeCredential();
  await verifyKnowledgeAttestation(engine, actual);
  await assert.rejects(
    verifyKnowledgeAttestation(engine, { ...actual, credentialId: 'unexpected' }),
    /attestation mismatch/,
  );
});

before(async () => {
  if (!store) return;
  await migrateUp(store.pool);
});

beforeEach(async () => {
  if (!store) return;
  await store.pool.query(
    'TRUNCATE ai_rate_limit_buckets, audit_events, outbox, leads, conversation_events, conversation_messages, engine_run_handles, conversation_credentials, conversations, ai_runs RESTART IDENTITY CASCADE',
  );
});

after(async () => {
  if (!store) return;
  await store.pool.query(
    'TRUNCATE ai_rate_limit_buckets, audit_events, outbox, leads, conversation_events, conversation_messages, engine_run_handles, conversation_credentials, conversations, ai_runs RESTART IDENTITY CASCADE',
  );
  await store.close();
});

test(
  'worker drains one start_run into committed ordered events and terminal state',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'worker-message-1',
      content: 'What is your MOQ?',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    const engine = new FakeEngine({
      script: ['Grounded ', 'answer.'],
      citations: [{ sourceId: 'faq-1', title: 'Public FAQ' }],
    });
    assert.equal(await processOne(store, engine, config), 'processed');
    const events = await store.listEvents(conversation.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ['token', 'token', 'citation', 'final'],
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4],
    );
    assert.equal((await store.getConversation(conversation.id))?.activeRunId, null);
    const assistantMessages = await store.pool.query<{ content: string }>(
      `SELECT content FROM conversation_messages
     WHERE conversation_id = $1 AND role = 'assistant'`,
      [conversation.id],
    );
    assert.deepEqual(assistantMessages.rows, [{ content: 'Grounded answer.' }]);
  },
);

test(
  'terminal run drains exactly one queued visitor message into a new outbox item',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'worker-message-a',
      content: 'first',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'worker-message-b',
      content: 'second',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    const engine = new FakeEngine({
      script: ['done'],
      citations: [{ sourceId: 'faq-1', title: 'Public FAQ' }],
    });
    assert.equal(await processOne(store, engine, config), 'processed');
    const current = await store.getConversation(conversation.id);
    assert.ok(current?.activeRunId);
    assert.equal(await processOne(store, engine, config), 'processed');
    assert.equal((await store.getConversation(conversation.id))?.activeRunId, null);
    const finals = (await store.listEvents(conversation.id)).filter(
      (event) => event.type === 'final',
    );
    assert.equal(finals.length, 2);
  },
);

test(
  'takeover fence prevents a worker from committing further engine output',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    const accepted = await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'worker-message-takeover',
      content: 'hello',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    assert.ok(accepted.run);
    await store.transitionControl({
      conversationId: conversation.id,
      expectedVersion: conversation.controlVersion,
      from: 'ai',
      to: 'human',
      assignedUserId: 'sales-1',
    });
    const engine = new FakeEngine({ script: ['must not appear'] });
    assert.equal(await processOne(store, engine, config), 'processed');
    assert.deepEqual(await store.listEvents(conversation.id), []);
  },
);
