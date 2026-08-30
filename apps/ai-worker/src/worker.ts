import { type Server, createServer } from 'node:http';
import { AnythingLlmEngine, assertNoToolSurface } from '@vibelingan-channel/ai-engine-anythingllm';
import { assertEngineUsable } from '@vibelingan-channel/ai-engine/capabilities';
import { EngineError } from '@vibelingan-channel/ai-engine/errors';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import type { ConversationEngine, EngineEvent } from '@vibelingan-channel/ai-engine/port';
import {
  enforceGroundedFinal,
  normalizeCitations,
  preparePublicTurns,
} from '@vibelingan-channel/ai-policy';
import {
  AiStore,
  type OutboxItem,
  type RunExecutionContext,
  migrateUp,
} from '@vibelingan-channel/ai-store';

export interface WorkerConfig {
  pollMs: number;
  leaseSeconds: number;
  maxAttempts: number;
  profileId: string;
  maxDeliveredOutputUnits: number;
  maxStreamDurationMs: number;
  maxToolCalls: number;
  approvedSourcePrefix: string;
  citationSiteOrigin: string;
}

export function validateWorkerConfig(config: WorkerConfig): WorkerConfig {
  if (config.leaseSeconds * 1_000 <= config.maxStreamDurationMs + 5_000) {
    throw new Error('AI_WORKER_LEASE_SECONDS must exceed AI_MAX_STREAM_DURATION_MS by 5 seconds');
  }
  if (!config.approvedSourcePrefix.trim()) {
    throw new Error('AI_APPROVED_SOURCE_PREFIX must not be empty');
  }
  const site = new URL(config.citationSiteOrigin);
  if (site.protocol !== 'https:' && !(site.protocol === 'http:' && site.hostname === 'localhost')) {
    throw new Error('AI_SITE_ORIGIN must be HTTPS or local HTTP');
  }
  return config;
}

export async function verifyKnowledgeAttestation(
  engine: ConversationEngine,
  expected: { credentialId: string; spaceId: string; rotationCounter: number },
): Promise<void> {
  const actual = await engine.attestKnowledgeCredential();
  if (
    actual.credentialId !== expected.credentialId ||
    actual.spaceId !== expected.spaceId ||
    actual.rotationCounter !== expected.rotationCounter
  ) {
    throw new Error('knowledge credential attestation mismatch');
  }
}

export async function processOne(
  store: AiStore,
  engine: ConversationEngine,
  config: WorkerConfig,
): Promise<'idle' | 'processed' | 'retried' | 'dead_letter'> {
  const item = await store.claimNextOutbox(config.leaseSeconds);
  if (!item) return 'idle';
  try {
    if (item.type === 'start_run') {
      await startRun(store, engine, item, config);
    } else if (item.type === 'cancel_run') {
      await cancelRun(store, engine, item);
    } else {
      throw new WorkerFailure('unavailable', `handler_not_configured:${item.type}`);
    }
    await store.completeOutbox(item.id, item.claimEpoch);
    return 'processed';
  } catch (caught) {
    const failure = normalizeFailure(caught);
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'outbox_attempt_failed',
        itemType: item.type,
        attempt: item.attempts,
        category: failure.category,
        stage: failure.message,
      }),
    );
    const disposition = await store.retryOutbox({
      id: item.id,
      claimEpoch: item.claimEpoch,
      category: failure.category,
      delaySeconds: Math.min(60, 2 ** Math.min(item.attempts, 5)),
      maxAttempts: config.maxAttempts,
    });
    if (disposition === 'dead_letter' && item.runId && item.type === 'start_run') {
      await store.terminalizeRun({
        runId: item.runId,
        reason: 'start_run_dead_letter',
        outboxId: item.id,
        failurePayload: { category: failure.category },
      });
    }
    return disposition === 'dead_letter' ? 'dead_letter' : 'retried';
  }
}

async function startRun(
  store: AiStore,
  engine: ConversationEngine,
  item: OutboxItem,
  config: WorkerConfig,
): Promise<void> {
  const runId = item.runId;
  if (!runId) throw new WorkerFailure('invalid_request', 'start_run_without_run');
  const claim = await workerStage('claim_run', () => store.claimRun(runId));
  if (!claim) return;
  if (claim.reclaimed) {
    // The previous owner lost its outbox lease. Incrementing claim_epoch above
    // fences any zombie; this worker cannot resume the old HTTP stream, so it
    // terminalizes instead of creating a duplicate provider generation.
    await workerStage('terminalize_reclaimed_run', () =>
      store.terminalizeRun({
        runId,
        reason: 'reclaimed',
        claimEpoch: claim.claimEpoch,
        failurePayload: { category: 'transient' },
      }),
    );
    return;
  }
  const context = await workerStage('load_run_context', () => store.getRunExecutionContext(runId));
  if (!context) throw new WorkerFailure('invalid_request', 'run_context_missing');
  const controller = new AbortController();
  const handle = await workerStage('create_engine_run', () =>
    engine.createRun(
      {
        operationId: context.operationId,
        conversationRef: context.conversationId,
        turns: preparePublicTurns(context.turns),
        profileId: config.profileId,
        locale: context.locale,
        limits: {
          maxDeliveredOutputUnits: config.maxDeliveredOutputUnits,
          maxStreamDurationMs: config.maxStreamDurationMs,
          maxToolCalls: config.maxToolCalls,
        },
      },
      controller.signal,
    ),
  );
  await workerStage('record_engine_handle', () =>
    store.recordEngineHandle({
      conversationId: context.conversationId,
      runId: context.runId,
      operationId: context.operationId,
      engineRunId: handle.engineRunId,
    }),
  );

  for await (const rawEvent of engine.streamRun(handle, controller.signal)) {
    if (!(await workerStage('check_run_fence', () => store.isRunCommitAuthorized(context)))) {
      controller.abort();
      return;
    }

    if (rawEvent.type === 'token' || rawEvent.type === 'citation') {
      // Citations arrive at the end on the hosted KB. Until the final evidence
      // set passes policy, neither its prose nor its source names are public.
      continue;
    }

    if (rawEvent.type === 'error') {
      const committed = await workerStage('finish_engine_error', () =>
        store.finishRunFenced({
          conversationId: context.conversationId,
          runId: context.runId,
          expectedControlVersion: context.controlVersion,
          claimEpoch: context.claimEpoch,
          status: 'failed',
          events: [storeEvent(rawEvent)],
        }),
      );
      if (!committed) {
        controller.abort();
        return;
      }
      return;
    }

    const policyResult = enforceGroundedFinal(rawEvent, {
      approvedSourcePrefix: config.approvedSourcePrefix,
    });
    const approved =
      policyResult.type === 'final'
        ? {
            ...policyResult,
            citations: normalizeCitations(policyResult.citations, {
              siteOrigin: config.citationSiteOrigin,
            }),
          }
        : policyResult;
    const safeEvents = approvedEvents(approved);
    const status = approved.type === 'final' ? 'completed' : 'failed';
    const committed = await workerStage(`finish_${status}`, () =>
      store.finishRunFenced({
        conversationId: context.conversationId,
        runId: context.runId,
        expectedControlVersion: context.controlVersion,
        claimEpoch: context.claimEpoch,
        status,
        events: safeEvents.map(storeEvent),
      }),
    );
    if (!committed) {
      controller.abort();
      return;
    }
    return;
  }
  throw new WorkerFailure('transient', 'stream_ended_without_terminal_event');
}

async function workerStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (caught) {
    if (caught instanceof WorkerFailure || caught instanceof EngineError) throw caught;
    throw new WorkerFailure('transient', stage);
  }
}

function approvedEvents(terminal: EngineEvent): EngineEvent[] {
  if (terminal.type !== 'final') return [terminal];
  // Vendor chunks were deliberately withheld until the final evidence set
  // passed. Replaying hundreds of now-approved chunks would add hundreds of DB
  // transactions without restoring real-time streaming, so publish the exact
  // approved final text once.
  const tokens: EngineEvent[] = [{ type: 'token', text: terminal.text }];
  const citations: EngineEvent[] = terminal.citations.map((citation) => ({
    type: 'citation',
    citation,
  }));
  return [...tokens, ...citations, terminal];
}

function storeEvent(event: EngineEvent): {
  type: 'token' | 'citation' | 'final' | 'error';
  payload: Record<string, unknown>;
} {
  if (
    event.type !== 'token' &&
    event.type !== 'citation' &&
    event.type !== 'final' &&
    event.type !== 'error'
  ) {
    throw new WorkerFailure('invalid_request', 'unsupported_engine_event');
  }
  const payload =
    event.type === 'token'
      ? { text: event.text }
      : event.type === 'citation'
        ? {
            sourceId: event.citation.sourceId,
            title: event.citation.title,
            ...(event.citation.url ? { url: event.citation.url } : {}),
          }
        : event.type === 'final'
          ? { text: event.text }
          : { category: event.category, retriable: event.retriable };
  return { type: event.type, payload };
}

async function cancelRun(
  store: AiStore,
  engine: ConversationEngine,
  item: OutboxItem,
): Promise<void> {
  if (!item.runId) return;
  const handle = await store.getEngineHandle(item.runId);
  if (handle && engine.capabilities.supportsOutOfBandStop) {
    await engine.cancelRun(handle);
  }
  await store.terminalizeRun({
    runId: item.runId,
    reason: 'cancel_requested',
  });
}

export function createWorkerHealthServer(store: AiStore, engine: ConversationEngine): Server {
  return createServer(async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }

    // Liveness answers "is this process up", never "is it able to work".
    // Checking the database here means a database blip restarts a perfectly
    // healthy container, and the restart cannot fix the database.
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'live', service: 'channel-ai-worker' }));
      return;
    }

    if (request.url !== '/readyz') {
      response.writeHead(404).end();
      return;
    }

    // Readiness checks EVERY dependency the worker needs to answer, and says
    // 503 when one is down, so the platform stops sending it work instead of
    // letting every run fail against an engine that is not there.
    try {
      const database = await store.health();
      const engineHealth = await engine.health();
      const status = engineHealth.status === 'live' ? 200 : 503;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: engineHealth.status, database }));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'unavailable' }));
    }
  });
}

class WorkerFailure extends Error {
  readonly category: string;

  constructor(category: string, safeDetail: string) {
    super(safeDetail);
    this.category = category;
  }
}

function normalizeFailure(caught: unknown): WorkerFailure {
  if (caught instanceof WorkerFailure) return caught;
  if (caught instanceof EngineError)
    return new WorkerFailure(caught.category, 'engine_operation_failed');
  return new WorkerFailure('transient', 'worker_operation_failed');
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid_${name}`);
  return value;
}

function envNonNegativeNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return value;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const engine = engineFromEnvironment();
  assertEngineUsable(engine.capabilities, {
    // The worker persists the run before any provider call. A reclaimed
    // RUNNING item increments claim_epoch and fails closed; it never replays
    // create/stream. This is the durable compensation for non-idempotent APIs.
    operationIdMappingLayerConfigured: true,
    unrecordedHandleRecoveryConfigured: true,
    answerPolicyRequiresCitations: true,
    knowledgeSourceConfigured: true,
  });
  if ((process.env.AI_ENGINE_ID ?? 'fake') === 'anythingllm') {
    await verifyKnowledgeAttestation(engine, {
      credentialId: requiredEnv('AI_KNOWLEDGE_CREDENTIAL_ID'),
      spaceId: requiredEnv('ANYTHINGLLM_WORKSPACE_SLUG'),
      rotationCounter: envNumber('ANYTHINGLLM_CREDENTIAL_ROTATION', 1),
    });
    if (!(engine instanceof AnythingLlmEngine)) {
      throw new Error('AnythingLLM engine construction mismatch');
    }
    await assertNoToolSurface(() => engine.inspectToolSurface());
  }
  const store = new AiStore(databaseUrl);
  await migrateUp(store.pool);
  await store.health();
  const config = validateWorkerConfig({
    pollMs: envNumber('AI_WORKER_POLL_MS', 250),
    leaseSeconds: envNumber('AI_WORKER_LEASE_SECONDS', 90),
    maxAttempts: envNumber('AI_WORKER_MAX_ATTEMPTS', 5),
    profileId: process.env.AI_PROFILE_ID ?? 'channel-public-v1',
    // The env var keeps its deployed name; the field does not. This bounds what
    // the worker RECEIVES, not what the vendor generates or bills — engines in
    // this protocol family accept a per-run token field, return success, and
    // ignore it. Renamed from maxOutputTokens, which promised the second thing.
    maxDeliveredOutputUnits: envNumber('AI_MAX_OUTPUT_TOKENS', 4096),
    maxStreamDurationMs: envNumber('AI_MAX_STREAM_DURATION_MS', 55_000),
    maxToolCalls: envNonNegativeNumber('AI_MAX_TOOL_CALLS', 0),
    approvedSourcePrefix: process.env.AI_APPROVED_SOURCE_PREFIX ?? 'channelkb',
    citationSiteOrigin: process.env.AI_SITE_ORIGIN ?? 'http://localhost:4321',
  });
  const healthServer = createWorkerHealthServer(store, engine);
  healthServer.listen(envNumber('PORT', 8080), '0.0.0.0');
  let shuttingDown = false;
  const shutdown = (): void => {
    shuttingDown = true;
    healthServer.close(() => void store.close());
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  while (!shuttingDown) {
    const disposition = await processOne(store, engine, config);
    if (disposition === 'idle') await delay(config.pollMs);
  }
}

function engineFromEnvironment(): ConversationEngine {
  const engineId = process.env.AI_ENGINE_ID ?? 'fake';
  if (engineId === 'fake') {
    return new FakeEngine({
      citations: [
        {
          sourceId: 'channelkb-g1-local-public-faq',
          // Named the way the approved corpus names its documents, because the
          // answer gate only grounds on that namespace. A fixture that would be
          // refused in production is a fixture that proves nothing.
          title: 'channelkb-g1-local-public-faq',
          retrievedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  }
  if (engineId !== 'anythingllm') throw new Error(`unsupported_AI_ENGINE_ID:${engineId}`);
  const baseUrl = requiredEnv('ANYTHINGLLM_BASE_URL');
  const apiKey = requiredEnv('ANYTHINGLLM_API_KEY');
  const workspaceSlug = requiredEnv('ANYTHINGLLM_WORKSPACE_SLUG');
  return new AnythingLlmEngine({
    baseUrl,
    apiKey,
    workspaceSlug,
    // The knowledge base holds an INSTANCE-WIDE developer token, not a
    // workspace-scoped read-only one: the same authenticated surface can read
    // system configuration and enumerate workspaces. Plain HTTP puts that
    // bearer in cleartext on the network path, and the supplied hosted KB was
    // found on exactly that footing on 2026-08-25. Remote HTTP therefore has to
    // be asked for by name, once, in a file that is not production.
    allowInsecureRemoteHttp: process.env.ALLOW_INSECURE_ANYTHINGLLM === 'true',
    engineVersion: requiredEnv('AI_ENGINE_VERSION'),
    imageDigest: requiredEnv('AI_ENGINE_IMAGE_DIGEST'),
    citationsVerified: process.env.ANYTHINGLLM_CITATIONS_VERIFIED === '1',
    credentialRotationCounter: envNumber('ANYTHINGLLM_CREDENTIAL_ROTATION', 1),
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
