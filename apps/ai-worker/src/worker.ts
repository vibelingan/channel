import { readFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { AnythingLlmEngine, assertNoToolSurface } from '@vibelingan-channel/ai-engine-anythingllm';
import {
  type EngineProvenance,
  assertEngineUsable,
  provenanceFromEnv,
} from '@vibelingan-channel/ai-engine/capabilities';
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

/**
 * Evidence produced by an authenticated round-trip against the live knowledge
 * base, written by scripts/probe-anythingllm.mjs. Secret-free by construction.
 */
export interface KnowledgeEvidence {
  schema: string;
  recordedAt: string;
  credentialId: string | null;
  workspaceSlug: string | null;
  workspaceId: string | null;
  rotationCounter: number | null;
  corpusGeneration: string | null;
  positiveControl: {
    retrieved: boolean;
    resultCount: number;
    approvedSourceCount: number;
    citationsObserved: number;
  };
  toolSurface: { inspected: boolean; enabledCount: number; verdict: string };
  transport: { https: boolean; insecureOverride: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow the evidence file's contents, rather than asserting a shape over it.
 *
 * The file crosses a trust boundary — it is disk I/O, and on a compromised or
 * simply half-written probe run it can be truncated, `null`, or the wrong JSON
 * entirely. A cast would let any of those through as a well-typed object whose
 * nested fields are `undefined`, and `verifyKnowledgeAttestation` would then
 * reason about `undefined` instead of refusing outright — the worst case being
 * a crash on `evidence.positiveControl.retrieved` deep inside the readiness
 * path rather than the clear refusal this exists to produce.
 */
export function parseKnowledgeEvidence(value: unknown, sourcePath: string): KnowledgeEvidence {
  if (!isRecord(value)) {
    throw new Error(`knowledge evidence at ${sourcePath} is not a JSON object`);
  }
  const record = value;
  if (typeof record.schema !== 'string' || typeof record.recordedAt !== 'string') {
    throw new Error(`knowledge evidence at ${sourcePath} is missing schema or recordedAt`);
  }
  const positiveControl = record.positiveControl;
  if (!isRecord(positiveControl)) {
    throw new Error(`knowledge evidence at ${sourcePath} is missing positiveControl`);
  }
  const toolSurface = record.toolSurface;
  if (!isRecord(toolSurface)) {
    throw new Error(`knowledge evidence at ${sourcePath} is missing toolSurface`);
  }
  const transport = record.transport;
  if (!isRecord(transport)) {
    throw new Error(`knowledge evidence at ${sourcePath} is missing transport`);
  }
  const num = (value: unknown): number => {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    schema: record.schema,
    recordedAt: record.recordedAt,
    credentialId: typeof record.credentialId === 'string' ? record.credentialId : null,
    workspaceSlug: typeof record.workspaceSlug === 'string' ? record.workspaceSlug : null,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : null,
    rotationCounter: typeof record.rotationCounter === 'number' ? record.rotationCounter : null,
    corpusGeneration: typeof record.corpusGeneration === 'string' ? record.corpusGeneration : null,
    positiveControl: {
      retrieved: positiveControl.retrieved === true,
      resultCount: num(positiveControl.resultCount),
      approvedSourceCount: num(positiveControl.approvedSourceCount),
      citationsObserved: num(positiveControl.citationsObserved),
    },
    toolSurface: {
      inspected: toolSurface.inspected === true,
      enabledCount: num(toolSurface.enabledCount),
      verdict: typeof toolSurface.verdict === 'string' ? toolSurface.verdict : 'unknown',
    },
    transport: {
      https: transport.https === true,
      insecureOverride: transport.insecureOverride === true,
    },
  };
}

/**
 * Prove the engine that is about to serve is the one the evidence was gathered
 * from — against the EVIDENCE, not against the environment.
 *
 * The previous check asked the adapter what it had been configured with and
 * compared that to the same variables the adapter was configured from. That is
 * a tautology: it passes against an empty workspace, against the wrong
 * workspace, and against a credential that can read the whole instance,
 * because none of those facts are inputs to it. It cannot fail for any reason
 * that matters, which is the most expensive kind of green.
 */
export async function verifyKnowledgeAttestation(
  engine: ConversationEngine,
  evidence: KnowledgeEvidence,
  options: {
    maxAgeMs?: number;
    expectedWorkspaceId?: string;
    expectedCorpusGeneration?: string;
    allowInsecureTransport?: boolean;
  } = {},
): Promise<void> {
  const actual = await engine.attestKnowledgeCredential();
  const reasons: string[] = [];

  if (evidence.schema !== 'channel.ai.kb-evidence/1') reasons.push('unrecognised evidence schema');
  if (actual.credentialId !== evidence.credentialId) {
    reasons.push('the serving credential is not the one the evidence was produced with');
  }
  if (actual.spaceId !== evidence.workspaceSlug) {
    reasons.push('the serving workspace is not the one the evidence was produced against');
  }
  if (!evidence.workspaceId) reasons.push('the evidence names no workspace id');
  if (options.expectedWorkspaceId && evidence.workspaceId !== options.expectedWorkspaceId) {
    reasons.push('the serving workspace id does not match the evidence');
  }
  if (!evidence.corpusGeneration) reasons.push('the evidence names no corpus generation');
  if (
    options.expectedCorpusGeneration &&
    evidence.corpusGeneration !== options.expectedCorpusGeneration
  ) {
    reasons.push('the serving corpus generation does not match the evidence');
  }
  if (Number(actual.rotationCounter) !== Number(evidence.rotationCounter)) {
    reasons.push('credential rotation counter does not match the evidence');
  }
  // The positive control is the part the old check had no equivalent of: an
  // empty workspace authenticates perfectly and answers nothing.
  if (!evidence.positiveControl?.retrieved || evidence.positiveControl.resultCount < 1) {
    reasons.push('no positive-control retrieval; an empty corpus cannot be ready');
  }
  if (Number(evidence.positiveControl?.approvedSourceCount ?? 0) < 1) {
    reasons.push('the positive control returned no approved source');
  }
  if (evidence.toolSurface?.inspected !== true) reasons.push('tool surface was never inspected');
  if (evidence.toolSurface?.verdict !== 'none') {
    reasons.push('the workspace has an agent or tool surface enabled');
  }
  if (evidence.transport?.https !== true && options.allowInsecureTransport !== true) {
    reasons.push('evidence was gathered over plaintext');
  }

  const maxAgeMs = options.maxAgeMs;
  if (maxAgeMs !== undefined) {
    const age = Date.now() - Date.parse(evidence.recordedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      reasons.push('the evidence is older than the accepted window');
    }
  }

  if (reasons.length > 0) {
    throw new Error(
      `refusing to serve; knowledge evidence is not acceptable:\n${reasons.map((r) => `  - ${r}`).join('\n')}`,
    );
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
    // ONE transaction. These were two statements: the outbox row committed as
    // permanently dead-lettered, and only then was the run failed. Anything
    // that stopped the process in between — a crash, a lost connection, a
    // container restart — left a conversation pointing at a run no worker would
    // ever claim, with the visitor watching a spinner that never resolves.
    const disposition = await store.failOutboxAttempt({
      id: item.id,
      claimEpoch: item.claimEpoch,
      category: failure.category,
      delaySeconds: Math.min(60, 2 ** Math.min(item.attempts, 5)),
      maxAttempts: config.maxAttempts,
      runId: item.runId,
      type: item.type,
      failurePayload: { category: failure.category },
    });
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
    // Load the evidence a real probe produced, and check the engine against
    // THAT. Reading the expected values out of the same environment the adapter
    // was built from proved only that two copies of one variable agree.
    const evidenceJson = process.env.AI_KB_EVIDENCE_JSON?.trim();
    const evidencePath = process.env.AI_KB_EVIDENCE_FILE?.trim();
    if (!evidenceJson && !evidencePath) {
      throw new Error('AI_KB_EVIDENCE_JSON or AI_KB_EVIDENCE_FILE is required for AnythingLLM');
    }
    let evidenceSource: string;
    let serialized: string;
    let evidence: KnowledgeEvidence;
    try {
      if (evidenceJson) {
        evidenceSource = 'AI_KB_EVIDENCE_JSON';
        serialized = evidenceJson;
      } else if (evidencePath) {
        evidenceSource = evidencePath;
        serialized = await readFile(evidencePath, 'utf8');
      } else {
        throw new Error('knowledge evidence location disappeared during startup');
      }
      const raw: unknown = JSON.parse(serialized);
      evidence = parseKnowledgeEvidence(raw, evidenceSource);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'unreadable';
      throw new Error(
        `refusing to serve; knowledge evidence is unusable (${detail}). Run \`pnpm test:ai:kb\` with AI_KB_EVIDENCE_FILE set against the approved workspace first.`,
      );
    }
    await verifyKnowledgeAttestation(engine, evidence, {
      maxAgeMs: envNumber('AI_KB_EVIDENCE_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000),
      expectedWorkspaceId: requiredEnv('ANYTHINGLLM_WORKSPACE_ID'),
      expectedCorpusGeneration: requiredEnv('AI_CORPUS_GENERATION'),
      allowInsecureTransport: process.env.ALLOW_INSECURE_ANYTHINGLLM === 'true',
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
      // A harmless synthetic source outside the public namespace gives the
      // process-level acceptance test a deterministic way to prove the final
      // publication gate fired. The production workspace stays public-only;
      // it is never polluted with a fake internal document just to make a
      // security observer turn green.
      citationScenarios: [
        {
          whenMessageIncludes: 'gateway test document',
          citations: [
            {
              sourceId: 'acceptance-unapproved-fixture',
              title: 'Acceptance-only unapproved fixture',
              retrievedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
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
    provenance: provenanceFromEnvironment(),
    citationsVerified: process.env.ANYTHINGLLM_CITATIONS_VERIFIED === '1',
    credentialRotationCounter: envNumber('ANYTHINGLLM_CREDENTIAL_ROTATION', 1),
  });
}

/**
 * Read the engine's provenance, saying which KIND of artifact it names.
 *
 * The previous contract required AI_ENGINE_IMAGE_DIGEST unconditionally. The
 * knowledge base this now talks to is a Git checkout on a VM, so the only
 * values an operator could supply were a Git SHA or a placeholder — both of
 * them false in a field named for an OCI digest, and false in the direction
 * that makes an audit look successful. `assertProvenance` rejects a commit sha
 * offered as a digest rather than storing it.
 */
export function provenanceFromEnvironment(env: NodeJS.ProcessEnv = process.env): EngineProvenance {
  return provenanceFromEnv(env);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
