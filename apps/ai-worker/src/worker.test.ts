import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import { PUBLICATION_BLOCKED } from '@vibelingan-channel/ai-policy';
import { AiStore, migrateUp } from '@vibelingan-channel/ai-store';
import {
  type KnowledgeEvidence,
  type WorkerConfig,
  parseKnowledgeEvidence,
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
    schema: 'channel.ai.kb-evidence/2',
    recordedAt: new Date().toISOString(),
    credentialId: attested.credentialId,
    workspaceSlug: attested.spaceId,
    workspaceId: 'workspace-id-1',
    rotationCounter: attested.rotationCounter,
    corpusGeneration: 'g1000',
    positiveControl: {
      retrieved: true,
      resultCount: 4,
      approvedSourceCount: 4,
      citationsObserved: 2,
    },
    generationControl: {
      sync: { ok: true, citationCount: 2 },
      stream: { ok: true, citationCount: 2 },
    },
    toolSurface: { inspected: true, enabledCount: 0, verdict: 'none' },
    transport: { https: true, insecureOverride: false },
  };
}

test('worker accepts an engine that matches real evidence', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  await verifyKnowledgeAttestation(engine, evidenceFor(attested), {
    expectedCredentialId: attested.credentialId,
    expectedWorkspaceId: 'workspace-id-1',
    expectedCorpusGeneration: 'g1000',
  });
});

test('worker binds evidence to the deployed workspace id and corpus generation', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  await assert.rejects(
    verifyKnowledgeAttestation(engine, evidenceFor(attested), {
      expectedWorkspaceId: 'different-workspace-id',
      expectedCorpusGeneration: 'g1000',
    }),
    /workspace id does not match/,
  );
  await assert.rejects(
    verifyKnowledgeAttestation(engine, evidenceFor(attested), {
      expectedWorkspaceId: 'workspace-id-1',
      expectedCorpusGeneration: 'g9999',
    }),
    /corpus generation does not match/,
  );
});

test('worker binds evidence to the operator-approved credential id', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  await assert.rejects(
    verifyKnowledgeAttestation(engine, evidenceFor(attested), {
      expectedCredentialId: 'not-the-approved-credential',
    }),
    /operator-approved credential/,
  );
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

test('worker refuses evidence from a failed or uncited generation surface', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  const evidence = evidenceFor(attested);
  await assert.rejects(
    verifyKnowledgeAttestation(engine, {
      ...evidence,
      generationControl: {
        ...evidence.generationControl,
        stream: { ok: false, citationCount: 0 },
      },
    }),
    /streaming generation did not complete/,
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

test('local plaintext evidence needs the same explicit override as the engine transport', async () => {
  const engine = new FakeEngine();
  const attested = await engine.attestKnowledgeCredential();
  const evidence = {
    ...evidenceFor(attested),
    transport: { https: false, insecureOverride: true },
  };
  await verifyKnowledgeAttestation(engine, evidence, { allowInsecureTransport: true });
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

/**
 * The evidence file crosses a trust boundary (disk I/O from a probe run) and
 * must be narrowed, not cast. A cast would let a truncated or malformed file
 * through as a well-typed object whose fields are `undefined`, and the
 * verifier would then reason about `undefined` instead of refusing outright.
 */
test('null evidence is refused with a clear message, not a crash', () => {
  assert.throws(() => parseKnowledgeEvidence(null, '/tmp/evidence.json'), /not a JSON object/);
});

test('a bare scalar (e.g. a truncated file parsing to a number) is refused', () => {
  assert.throws(() => parseKnowledgeEvidence(42, '/tmp/evidence.json'), /not a JSON object/);
  assert.throws(() => parseKnowledgeEvidence('oops', '/tmp/evidence.json'), /not a JSON object/);
});

test('an object missing schema or recordedAt is refused, not silently accepted', () => {
  assert.throws(
    () => parseKnowledgeEvidence({ recordedAt: '2026-01-01T00:00:00Z' }, '/tmp/evidence.json'),
    /missing schema or recordedAt/,
  );
});

test('an object missing the nested positiveControl/generationControl/toolSurface/transport is refused', () => {
  const base = { schema: 'channel.ai.kb-evidence/2', recordedAt: '2026-01-01T00:00:00Z' };
  assert.throws(
    () => parseKnowledgeEvidence(base, '/tmp/evidence.json'),
    /missing positiveControl/,
  );
  assert.throws(
    () => parseKnowledgeEvidence({ ...base, positiveControl: {} }, '/tmp/evidence.json'),
    /missing generationControl/,
  );
  assert.throws(
    () =>
      parseKnowledgeEvidence(
        { ...base, positiveControl: {}, generationControl: {} },
        '/tmp/evidence.json',
      ),
    /missing generationControl sync or stream/,
  );
  const generationControl = { sync: {}, stream: {} };
  assert.throws(
    () =>
      parseKnowledgeEvidence(
        { ...base, positiveControl: {}, generationControl },
        '/tmp/evidence.json',
      ),
    /missing toolSurface/,
  );
  assert.throws(
    () =>
      parseKnowledgeEvidence(
        { ...base, positiveControl: {}, generationControl, toolSurface: {} },
        '/tmp/evidence.json',
      ),
    /missing transport/,
  );
});

test('a well-formed evidence object narrows cleanly, coercing loose types', () => {
  const parsed = parseKnowledgeEvidence(
    {
      schema: 'channel.ai.kb-evidence/2',
      recordedAt: '2026-01-01T00:00:00Z',
      credentialId: 'abc',
      workspaceSlug: 'ws',
      workspaceId: 'workspace-id-1',
      rotationCounter: 2,
      corpusGeneration: 'g1000',
      positiveControl: {
        retrieved: true,
        resultCount: 4,
        approvedSourceCount: 4,
        citationsObserved: 2,
      },
      generationControl: {
        sync: { ok: true, citationCount: 2 },
        stream: { ok: true, citationCount: 2 },
      },
      toolSurface: { inspected: true, enabledCount: 0, verdict: 'none' },
      transport: { https: true, insecureOverride: false },
    },
    '/tmp/evidence.json',
  );
  assert.equal(parsed.credentialId, 'abc');
  assert.equal(parsed.positiveControl.retrieved, true);
  assert.equal(parsed.generationControl.stream.ok, true);
  assert.equal(parsed.toolSurface.verdict, 'none');
});

test('a stray field never survives narrowing, and nested junk defaults safely', () => {
  const parsed = parseKnowledgeEvidence(
    {
      schema: 'channel.ai.kb-evidence/2',
      recordedAt: '2026-01-01T00:00:00Z',
      injected: 'DROP TABLE ai_runs;',
      positiveControl: { retrieved: 'yes', resultCount: 'many' },
      generationControl: { sync: {}, stream: {} },
      toolSurface: {},
      transport: {},
    },
    '/tmp/evidence.json',
  );
  assert.equal((parsed as unknown as Record<string, unknown>).injected, undefined);
  assert.equal(parsed.positiveControl.retrieved, false); // "yes" !== true
  assert.equal(parsed.positiveControl.resultCount, 0); // Number('many') is NaN -> coerced to 0 below
  assert.equal(parsed.toolSurface.verdict, 'unknown');
});
