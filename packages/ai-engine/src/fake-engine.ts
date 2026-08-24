/**
 * A deterministic in-memory engine (LLD-002 §8 rule 7).
 *
 * This is a first-class artifact, not a test stub. Every BFF integration test
 * runs against it with a real database, so the state-machine and race tests are
 * deterministic and need no vendor. It is also the conformance suite's first
 * passing member: a suite no implementation passes proves nothing.
 *
 * Determinism rules: no wall clock (an ISO instant is injected), no randomness,
 * no timers. Scripted failures are explicit, one-shot, and consumed on use.
 */

import type { EngineCapabilities } from './capabilities.ts';
import type { EngineErrorCategory } from './errors.ts';
import type {
  ConversationEngine,
  EngineCancelResult,
  EngineEvent,
  EngineHealth,
  EngineRunHandle,
  EngineRunRequest,
  KnowledgeAttestation,
} from './port.ts';

export type ScriptedFailure =
  | { kind: 'http_500' | 'socket_reset' | 'malformed_frame' }
  | { kind: 'timeout' }
  | { kind: 'overlong_output' };

export interface FakeEngineOptions {
  /** Overrides for the declared capabilities. */
  capabilities?: Partial<EngineCapabilities>;
  /** Fixed instant used for every timestamp. No wall clock is ever read. */
  now?: string;
  /** Tokens a successful run emits, in order. */
  script?: string[];
  /** Citations a successful run emits before its final event. */
  citations?: Array<{ sourceId: string; title: string; url?: string; retrievedAt?: string }>;
  knowledgeCredentialId?: string;
  knowledgeSpaceId?: string;
}

interface RunState {
  handle: EngineRunHandle;
  status: 'running' | 'finished';
  /** Captured at create, the way a real adapter configures the vendor up front. */
  limits: EngineRunRequest['limits'];
}

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  engineId: 'fake',
  engineVersion: '0.1.0',
  supportsIdempotentCreate: true,
  supportsRunLookupByOperationId: true,
  supportsStop: true,
  supportsOutOfBandStop: true,
  supportsCitations: true,
};

export class FakeEngine implements ConversationEngine {
  readonly capabilities: EngineCapabilities;

  readonly #now: string;
  readonly #script: string[];
  readonly #citations: FakeEngineOptions['citations'];
  readonly #runsByOperationId = new Map<string, RunState>();
  readonly #runsByEngineRunId = new Map<string, RunState>();

  /** Present only when the capability is declared — see the constructor. */
  findRunByOperationId?: (operationId: string) => Promise<EngineRunHandle | null>;

  #nextRunSeq = 1;
  #scriptedFailure: ScriptedFailure | undefined;
  #credentialId: string;
  #spaceId: string;
  #rotationCounter = 1;
  /** Set by the crash harness: the next create forgets it recorded anything. */
  #dropNextRecord = false;

  constructor(options: FakeEngineOptions = {}) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.#now = options.now ?? '2026-01-01T00:00:00.000Z';
    this.#script = options.script ?? ['Our ', 'MOQ ', 'is ', '500 ', 'units.'];
    this.#citations = options.citations;
    this.#credentialId = options.knowledgeCredentialId ?? 'cred-fake-0001';
    this.#spaceId = options.knowledgeSpaceId ?? 'space-public-cs';

    // Keep the declared capability and the optional method in agreement; the
    // conformance suite asserts this, because a startup check that reads a flag
    // the object contradicts is a check that lies.
    //
    // It is an instance field rather than a prototype method precisely so that
    // "absent" is representable: deleting a prototype method off an instance
    // does nothing, so the earlier shape could never have honoured a false
    // capability flag.
    if (this.capabilities.supportsRunLookupByOperationId) {
      this.findRunByOperationId = (operationId: string) =>
        Promise.resolve(this.#runsByOperationId.get(operationId)?.handle ?? null);
    }
  }

  /** Test hook: the next stream fails this way, once. */
  scriptFailure(failure: ScriptedFailure): void {
    this.#scriptedFailure = failure;
  }

  /** Test hook: simulate a crash between the vendor call and recording its handle. */
  dropNextRecord(): void {
    this.#dropNextRecord = true;
  }

  /** Test hook: rotate the knowledge credential. */
  rotateKnowledgeCredential(credentialId?: string): void {
    this.#credentialId =
      credentialId ?? `cred-fake-${String(this.#rotationCounter + 1).padStart(4, '0')}`;
    this.#rotationCounter += 1;
  }

  createRun(request: EngineRunRequest, signal: AbortSignal): Promise<EngineRunHandle> {
    if (signal.aborted) {
      return Promise.reject(new Error('aborted before create'));
    }

    const existing = this.#runsByOperationId.get(request.operationId);
    if (existing) {
      // Replay-safe: one operationId, one run, the same handle. This is the
      // property the whole fencing design in LLD-001 depends on.
      return Promise.resolve(existing.handle);
    }

    const handle: EngineRunHandle = {
      operationId: request.operationId,
      engineRunId: `fake-run-${this.#nextRunSeq++}`,
    };
    const state: RunState = { handle, status: 'running', limits: request.limits };
    this.#runsByEngineRunId.set(handle.engineRunId, state);

    if (this.#dropNextRecord) {
      // The vendor created the run; we "crashed" before recording it locally.
      // A replay must still resolve to this same run rather than making another.
      this.#dropNextRecord = false;
      this.#runsByOperationId.set(request.operationId, state);
      return Promise.resolve(handle);
    }

    this.#runsByOperationId.set(request.operationId, state);
    return Promise.resolve(handle);
  }

  async *streamRun(handle: EngineRunHandle, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const state = this.#runsByEngineRunId.get(handle.engineRunId);
    if (!state) {
      yield this.#error('invalid_request', 'unknown run');
      return;
    }

    const failure = this.#scriptedFailure;
    this.#scriptedFailure = undefined;

    if (failure?.kind === 'timeout') {
      state.status = 'finished';
      yield this.#error('timeout', 'stream exceeded maxStreamDurationMs');
      return;
    }

    if (
      failure?.kind === 'http_500' ||
      failure?.kind === 'socket_reset' ||
      failure?.kind === 'malformed_frame'
    ) {
      state.status = 'finished';
      // Every vendor shape normalizes to the same closed category. The BFF must
      // never see the vendor's own words.
      yield this.#error('transient', failure.kind);
      return;
    }

    const tokens =
      failure?.kind === 'overlong_output'
        ? Array.from({ length: 10_000 }, (_, index) => `t${index} `)
        : this.#script;

    // Nothing here is time-based, so an abort is observed on the next loop
    // rather than mid-await.
    let emitted = 0;
    for (const text of tokens) {
      if (signal.aborted) return;
      if (emitted >= state.limits.maxDeliveredOutputUnits) {
        // The limit is the adapter's to enforce — a vendor that keeps talking
        // past it must not be able to keep the BFF appending. Per LLD-002 §9
        // this ends the run rather than truncating silently.
        state.status = 'finished';
        yield this.#error('timeout', 'exceeded maxDeliveredOutputUnits');
        return;
      }
      yield { type: 'token', text };
      emitted += 1;
    }

    if (signal.aborted) return;

    const citations = (this.#citations ?? []).map((citation) => ({
      sourceId: citation.sourceId,
      title: citation.title,
      ...(citation.url === undefined ? {} : { url: citation.url }),
      retrievedAt: citation.retrievedAt ?? this.#now,
    }));

    for (const citation of citations) {
      if (signal.aborted) return;
      yield { type: 'citation', citation };
    }

    state.status = 'finished';
    yield {
      type: 'final',
      text: this.#script.join(''),
      citations,
      usage: { inputTokens: 12, outputTokens: emitted },
    };
  }

  cancelRun(handle: EngineRunHandle): Promise<EngineCancelResult> {
    const state = this.#runsByEngineRunId.get(handle.engineRunId);
    if (!state) return Promise.resolve('unknown_run');
    if (state.status === 'finished') return Promise.resolve('already_finished');
    state.status = 'finished';
    return Promise.resolve('stopped');
  }

  health(): Promise<EngineHealth> {
    return Promise.resolve({ status: 'live', checkedAt: this.#now });
  }

  attestKnowledgeCredential(): Promise<KnowledgeAttestation> {
    return Promise.resolve({
      credentialId: this.#credentialId,
      rotationCounter: this.#rotationCounter,
      spaceId: this.#spaceId,
    });
  }

  #error(category: EngineErrorCategory, safeDetail: string): EngineEvent {
    return {
      type: 'error',
      category,
      retriable: category === 'transient' || category === 'timeout',
      safeDetail,
    };
  }
}
