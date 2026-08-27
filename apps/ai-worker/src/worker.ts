import { type Server, createServer } from 'node:http';
import { AnythingLlmEngine } from '@vibelingan-channel/ai-engine-anythingllm';
import { assertEngineUsable } from '@vibelingan-channel/ai-engine/capabilities';
import { EngineError } from '@vibelingan-channel/ai-engine/errors';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import type { ConversationEngine, EngineEvent } from '@vibelingan-channel/ai-engine/port';
import { enforceGroundedFinal, preparePublicTurns } from '@vibelingan-channel/ai-policy';
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
}

export function validateWorkerConfig(config: WorkerConfig): WorkerConfig {
  if (config.leaseSeconds * 1_000 <= config.maxStreamDurationMs + 5_000) {
    throw new Error('AI_WORKER_LEASE_SECONDS must exceed AI_MAX_STREAM_DURATION_MS by 5 seconds');
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
    const disposition = await store.retryOutbox({
      id: item.id,
      claimEpoch: item.claimEpoch,
      category: failure.category,
      delaySeconds: Math.min(60, 2 ** Math.min(item.attempts, 5)),
      maxAttempts: config.maxAttempts,
    });
    if (disposition === 'dead_letter' && item.runId) {
      await store.terminalizeRun({
        runId: item.runId,
        status: 'failed',
        eventType: 'run.failed',
        eventPayload: { category: failure.category },
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
  if (!item.runId) throw new WorkerFailure('invalid_request', 'start_run_without_run');
  const claim = await store.claimRun(item.runId);
  if (!claim) return;
  if (claim.reclaimed) {
    // The previous owner lost its outbox lease. Incrementing claim_epoch above
    // fences any zombie; this worker cannot resume the old HTTP stream, so it
    // terminalizes instead of creating a duplicate provider generation.
    await store.terminalizeRun({
      runId: item.runId,
      status: 'failed',
      eventType: 'run.failed',
      eventPayload: { category: 'transient' },
    });
    return;
  }
  const context = await store.getRunExecutionContext(item.runId);
  if (!context) throw new WorkerFailure('invalid_request', 'run_context_missing');
  const controller = new AbortController();
  const handle = await engine.createRun(
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
  );
  await store.recordEngineHandle({
    conversationId: context.conversationId,
    runId: context.runId,
    operationId: context.operationId,
    engineRunId: handle.engineRunId,
  });

  let terminal: 'completed' | 'failed' | null = null;
  for await (const rawEvent of engine.streamRun(handle, controller.signal)) {
    const event = enforceGroundedFinal(rawEvent);
    const committed = await appendEngineEvent(store, context, event);
    if (!committed) {
      controller.abort();
      return;
    }
    if (event.type === 'final') terminal = 'completed';
    if (event.type === 'error') terminal = 'failed';
  }
  if (!terminal) throw new WorkerFailure('transient', 'stream_ended_without_terminal_event');
  await store.terminalizeRun({ runId: item.runId, status: terminal });
}

async function appendEngineEvent(
  store: AiStore,
  context: RunExecutionContext,
  event: EngineEvent,
): Promise<boolean> {
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
  const committed = await store.appendEventFenced({
    conversationId: context.conversationId,
    runId: context.runId,
    expectedControlVersion: context.controlVersion,
    claimEpoch: context.claimEpoch,
    type: event.type,
    payload,
  });
  return committed !== null;
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
    status: 'cancelled',
    eventType: 'assistant.cancelled',
    eventPayload: {},
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
    maxToolCalls: envNumber('AI_MAX_TOOL_CALLS', 2),
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
          sourceId: 'local-public-faq',
          title: 'Local public FAQ fixture',
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
    version: requiredEnv('AI_ENGINE_VERSION'),
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
