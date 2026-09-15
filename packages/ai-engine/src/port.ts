/**
 * The `ConversationEngine` port (LLD-002 §4–§5).
 *
 * This file defines what the assistant's brain must be able to do, in words
 * that name no vendor. It is written before any adapter exists — written after,
 * an adapter's assumptions leak in and the boundary becomes a hole shaped like
 * one vendor.
 *
 * What the port must never own: conversation state, control version, sequences,
 * any database access, business retry decisions, refusal policy, request-scoped
 * visitor identity or PII, and the HTTP response.
 */

import type { EngineCapabilities } from './capabilities.ts';
import type { EngineErrorCategory } from './errors.ts';

/** A turn of conversation, content only. */
export interface EngineTurn {
  /**
   * No 'human' role, deliberately. Whether a returned-to-AI conversation
   * replays a salesperson's turns — and under what redaction rule — is
   * LLD-001 open question 3. Human turns routinely carry contact details the
   * visitor gave a person, so replaying them unredacted would cross the PII
   * boundary this port draws. Adding the role later is additive; adding it now
   * would decide a privacy question by accident.
   */
  role: 'visitor' | 'assistant';
  text: string;
}

export interface EngineRunRequest {
  /** Stable id for replay-safe creation. Derived from the run row (LLD-001 §3). */
  operationId: string;
  /** Opaque correlation id for logs and vendor metadata. Never the visitor's id. */
  conversationRef: string;
  /** Ordered turns. Content only — no visitor identity, no contact fields. */
  turns: EngineTurn[];
  /** Named, versioned server-side profile. Never raw prompt text from a client. */
  profileId: string;
  locale: string;
  limits: EngineRunLimits;
}

export interface EngineRunLimits {
  /**
   * Ceiling on output DELIVERED to this process, in estimated units.
   *
   * Renamed from `maxOutputTokens`, which promised something no adapter could
   * keep. It is not a token count and not a vendor-side cap:
   *
   *  - it is an estimate, because chat protocols in this family report real
   *    usage only after the answer is complete — too late to stop anything;
   *  - it bounds what this process RECEIVES, not what the vendor generates or
   *    bills. Engines in the retrieval-chat family measured for this port
   *    accept a per-run token field, return success, and ignore it — so there
   *    is no per-run limit an adapter can meaningfully send.
   *
   * For the worst-case vendor generation and cost, use
   * `EngineCapabilities.vendorMaxOutputTokens` — the engine's own configured
   * ceiling, which is the only number the vendor actually honours.
   */
  maxDeliveredOutputUnits: number;
  maxStreamDurationMs: number;
  maxToolCalls: number;
}

export interface EngineRunHandle {
  operationId: string;
  /** Vendor run id, opaque to every caller. Never leaves the BFF. */
  engineRunId: string;
}

export interface EngineCitation {
  /** Stable id in the knowledge space. Not a vendor-internal document handle. */
  sourceId: string;
  title: string;
  url?: string;
  snippet?: string;
  /** ISO 8601. */
  retrievedAt: string;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Normalized stream events.
 *
 * There is no `tool_call` variant: tool-call visibility is not surfaced to the
 * visitor (LLD-002 open question 3). Adding one later is additive.
 */
export type EngineEvent =
  | { type: 'token'; text: string }
  | { type: 'citation'; citation: EngineCitation }
  | { type: 'final'; text: string; citations: EngineCitation[]; usage?: EngineUsage }
  | {
      type: 'error';
      category: EngineErrorCategory;
      retriable: boolean;
      safeDetail?: string;
    };

export type EngineCancelResult = 'stopped' | 'already_finished' | 'unknown_run';

/**
 * Readiness status. Deliberately coarse: ADR-001 requires every integration to
 * report a safe LIVE/DISABLED state into readiness, and anything richer tends
 * to leak a hostname or a path into a public surface.
 */
export interface EngineHealth {
  status: 'live' | 'degraded' | 'disabled';
  /** ISO 8601. */
  checkedAt: string;
}

/**
 * Non-secret attestation of the knowledge credential the engine is configured
 * with. SECURITY.md §4 requires the BFF to confirm at startup that the
 * credential which passed the pre-deploy scope probe is the one now serving —
 * and the BFF cannot inspect that credential itself, because it does not hold
 * it and must not. So the holder attests.
 */
export interface KnowledgeAttestation {
  /** Stable, opaque identity — a hash or key id, never the key. */
  credentialId: string;
  /** Increments on rotation, so a silent swap is detectable. */
  rotationCounter: number;
  /** The knowledge space the credential is scoped to, by public identifier. */
  spaceId: string;
}

export interface ConversationEngine {
  /** Static description of what this engine guarantees. Read at startup. */
  readonly capabilities: EngineCapabilities;

  /**
   * Create a run. MUST be replay-safe with respect to `operationId` when
   * `capabilities.supportsIdempotentCreate` is true: calling twice with the
   * same operationId yields one run and the same handle.
   */
  createRun(request: EngineRunRequest, signal: AbortSignal): Promise<EngineRunHandle>;

  /**
   * Stream normalized events for a run. The caller commits each event to the
   * ordered log before it becomes visible; the engine never writes to a
   * response. Must terminate on `signal` abort.
   *
   * Separate from `createRun` on purpose: LLD-001 §5 records the vendor run id
   * and then authorizes the run under a version check *between* the two, and a
   * single create-and-stream call would leave nowhere to put either write.
   */
  streamRun(handle: EngineRunHandle, signal: AbortSignal): AsyncIterable<EngineEvent>;

  /** Idempotent. An unknown or already-finished run is success, not an error. */
  cancelRun(handle: EngineRunHandle): Promise<EngineCancelResult>;

  /**
   * Resolve a handle from an operationId alone — needed to reconcile a run
   * created just before a crash. Present only when
   * `capabilities.supportsRunLookupByOperationId` is true.
   */
  findRunByOperationId?(operationId: string): Promise<EngineRunHandle | null>;

  /** Safe status for readiness. Never returns credentials, hosts, or paths. */
  health(): Promise<EngineHealth>;

  /** See `KnowledgeAttestation`. Carries no secret material. */
  attestKnowledgeCredential(): Promise<KnowledgeAttestation>;
}
