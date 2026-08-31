import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import { PUBLICATION_BLOCKED } from '@vibelingan-channel/ai-policy';
import { AiStore, migrateUp } from '@vibelingan-channel/ai-store';
import {
  type KnowledgeEvidence,
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
  maxToolCalls: 0,
  approvedSourcePrefix: 'channelkb',
  citationSiteOrigin: 'https://site.example',
};

test('worker lease must outlive the longest permitted provider stream', () => {
  assert.throws(
    () => validateWorkerConfig({ ...config, leaseSeconds: 5, maxStreamDurationMs: 1_000 }),
    /must exceed/,
  );
  assert.equal(validateWorkerConfig(config), config);
});

/**
 * Startup must check the engine against INDEPENDENT evidence.
 *
 * The old check compared the adapter's configuration with the environment the
 * adapter was configured from, which cannot fail for any reason that matters.
 * Each case below is one it used to pass.
 */
function evidenceFor(attested: {
  credentialId: string;
  spaceId: string;
  rotationCounter: number;
}): KnowledgeEvidence {
  return {
    schema: 'channel.ai.kb-evidence/1',
    recordedAt: new Date().toISOString(),
    credentialId: attested.credentialId,
    workspaceSlug: attested.spaceId,
    rotationCounter: attested.rotationCounter,
    corpusGeneration: 'g1000',
    positiveControl: {
      retrieved: true,
      resultCount: 4,
      approvedSourceCount: 4,
      citationsObserved: 2,
    },
    toolSurface: { inspected: true, enabledCount: 0, verdict: 'none' },
    transport: { https: true, insecureOverride: false },
  };
}

test('worker accepts an engine that matches real evidence', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  await verifyKnowledgeAttestation(engine, evidenceFor(attested));
});

test('worker refuses a knowledge credential whose attested identity drifts', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidenceFor(attested),
      credentialId: 'unexpected',
    }),
    /serving credential is not the one the evidence/,
  );
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidenceFor(attested),
      workspaceSlug: 'some-other-workspace',
    }),
    /serving workspace is not the one the evidence/,
  );
  await assert.rejects(
    verifyKnowledgeAttestation(engine, { ...evidenceFor(attested), rotationCounter: 99 }),
    /rotation counter does not match/,
  );
});

test('an EMPTY workspace is refused, however cleanly it authenticates', async () => {
  // The case the tautology could never catch: credentials valid, workspace
  // real, retrieval returning nothing. Readiness would have said live.
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  const evidence = evidenceFor(attested);
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidence,
      positiveControl: { ...evidence.positiveControl, retrieved: false, resultCount: 0 },
    }),
    /no positive-control retrieval/,
  );
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidence,
      positiveControl: { ...evidence.positiveControl, approvedSourceCount: 0 },
    }),
    /no approved source/,
  );
});

test('an enabled tool surface, or one never looked at, is refused', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  const evidence = evidenceFor(attested);
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidence,
      toolSurface: { inspected: true, enabledCount: 1, verdict: 'enabled' },
    }),
    /agent or tool surface enabled/,
  );
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidence,
      toolSurface: { inspected: false, enabledCount: 0, verdict: 'none' },
    }),
    /never inspected/,
  );
});

test('evidence gathered over plaintext, or gone stale, is refused', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  const evidence = evidenceFor(attested);
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidence,
      transport: { https: false, insecureOverride: true },
    }),
    /gathered over plaintext/,
  );
  await assert.rejects(
    verifyKnowledgeAttestation(
      engine,
      { ...evidence, recordedAt: new Date(Date.now() - 60_000).toISOString() },
      { maxAgeMs: 1_000 },
    ),
    /older than the accepted window/,
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
      citations: [
        {
          sourceId: 'channelkb-g1-public-faq',
          title: 'Public FAQ',
          url: 'https://site.example/public-faq',
        },
      ],
    });
    assert.equal(await processOne(store, engine, config), 'processed');
    const events = await store.listEvents(conversation.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ['token', 'citation', 'final'],
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2, 3],
    );
    assert.equal((await store.getConversation(conversation.id))?.activeRunId, null);
    const assistantMessages = await store.pool.query<{ content: string }>(
      `SELECT content FROM conversation_messages
     WHERE conversation_id = $1 AND role = 'assistant'`,
      [conversation.id],
    );
    assert.deepEqual(assistantMessages.rows, [{ content: 'Grounded answer.' }]);
    assert.equal(events[1]?.payload.url, 'https://site.example/public-faq');
  },
);

test(
  'worker drops an off-site citation link before the approved event batch commits',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'worker-message-offsite-link',
      content: 'What is public?',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    const engine = new FakeEngine({
      script: ['Public answer.'],
      citations: [
        {
          sourceId: 'channelkb-g1-public-faq',
          title: 'Public FAQ',
          url: 'https://site.example.evil.test/phish',
        },
      ],
    });

    assert.equal(await processOne(store, engine, config), 'processed');
    const citation = (await store.listEvents(conversation.id)).find(
      (event) => event.type === 'citation',
    );
    assert.ok(citation);
    assert.equal(citation.payload.url, undefined);
  },
);

test(
  'worker never publishes streamed tokens or citations rejected by the final public-source gate',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'worker-message-unpublishable',
      content: 'Tell me the internal escalation path',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    const engine = new FakeEngine({
      script: ['INTERNAL_ONLY_ANSWER'],
      citations: [{ sourceId: 'internal-1', title: 'hermes-skills-escalation' }],
    });

    assert.equal(await processOne(store, engine, config), 'processed');
    const events = await store.listEvents(conversation.id);

    assert.deepEqual(
      events.map((event) => event.type),
      ['error'],
    );
    // The CATEGORY, not merely that an error occurred. "An error happened" is
    // satisfied by a provider outage or a timeout, so on its own it is not
    // evidence that the publication gate is what stopped this.
    assert.equal(
      (events[0]?.payload as { category?: string } | undefined)?.category,
      PUBLICATION_BLOCKED,
      'the internal source was blocked by something other than the publication gate',
    );
    assert.doesNotMatch(JSON.stringify(events), /INTERNAL_ONLY_ANSWER|hermes-skills/);
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
      citations: [{ sourceId: 'channelkb-g1-public-faq', title: 'Public FAQ' }],
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
