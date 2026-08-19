/**
 * `ConversationEngine` adapter for AnythingLLM (ADR-002).
 *
 * Everything vendor-shaped is confined to this file. The BFF sees only the port
 * — which is what makes ADR-002's "the exit is already built" claim true rather
 * than aspirational.
 */

import { createHash } from 'node:crypto';
import {
  type ConversationEngine,
  type EngineCancelResult,
  type EngineCapabilities,
  type EngineCitation,
  EngineError,
  type EngineErrorCategory,
  type EngineEvent,
  type EngineHealth,
  type EngineRunHandle,
  type EngineRunRequest,
  type KnowledgeAttestation,
} from '@vibelingan-channel/ai-engine';
import { createReasoningFilter } from './reasoning.ts';

export interface AnythingLlmEngineConfig {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
  /** Pinned vendor release, recorded on every run row for incident scoping. */
  engineVersion: string;
  imageDigest?: string;
  /** Bumped by whoever rotates the key, so a swap is visible in attestation. */
  rotationCounter?: number;
  fetchImpl?: typeof fetch;
}

/** Vendor SSE frame. Only the fields we depend on are named. */
interface VendorFrame {
  type?: string;
  textResponse?: string | null;
  sources?: VendorSource[];
  close?: boolean;
  error?: string | boolean | null;
}

interface VendorSource {
  id?: string;
  title?: string;
  description?: string;
  docSource?: string;
  url?: string;
  text?: string;
  published?: string;
}

function categoryForStatus(status: number): EngineErrorCategory {
  if (status === 429) return 'quota';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 401 || status === 403) return 'unavailable';
  if (status === 404) return 'invalid_request';
  return 'transient';
}

export class AnythingLlmEngine implements ConversationEngine {
  readonly capabilities: EngineCapabilities;

  readonly #config: AnythingLlmEngineConfig;
  readonly #fetch: typeof fetch;
  /** Pending request bodies, keyed by operationId, awaiting their stream. */
  readonly #pending = new Map<string, EngineRunRequest>();
  /** In-flight streams this process owns, so it can abort what it holds. */
  readonly #inFlight = new Map<string, AbortController>();

  constructor(config: AnythingLlmEngineConfig) {
    this.#config = config;
    this.#fetch = config.fetchImpl ?? fetch;
    this.capabilities = {
      engineId: 'anythingllm',
      engineVersion: config.engineVersion,
      ...(config.imageDigest ? { imageDigest: config.imageDigest } : {}),
      // The chat API creates and answers in one call, so there is no run to
      // create idempotently. LLD-001 §7's operation-id mapping layer is the
      // compensation, and the startup check enforces that it is configured.
      supportsIdempotentCreate: false,
      supportsRunLookupByOperationId: false,
      // The owner aborts its own connection — see LLD-002 §7.1.
      supportsStop: true,
      // No stop-by-run-id exists in this protocol family. ADR-002 §3.
      supportsOutOfBandStop: false,
      supportsCitations: true,
    };
  }

  /**
   * No vendor call happens here, deliberately.
   *
   * This vendor has no "create a run" operation: the single chat call both
   * starts and answers. The port keeps create and stream separate because
   * LLD-001 §5 records the run id and authorizes the run *between* them, so
   * this mints the handle and defers the request to `streamRun`.
   */
  async createRun(request: EngineRunRequest, signal: AbortSignal): Promise<EngineRunHandle> {
    signal.throwIfAborted();
    this.#pending.set(request.operationId, request);
    return { operationId: request.operationId, engineRunId: `allm:${request.operationId}` };
  }

  async *streamRun(handle: EngineRunHandle, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const request = this.#pending.get(handle.operationId);
    if (!request) {
      yield {
        type: 'error',
        category: 'invalid_request',
        retriable: false,
        safeDetail: 'no pending request for this handle',
      };
      return;
    }
    this.#pending.delete(handle.operationId);

    const controller = new AbortController();
    this.#inFlight.set(handle.operationId, controller);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    // A duration cap the caller cannot forget to enforce. Without it a vendor
    // that stops sending frames without closing holds the worker forever.
    const deadline = setTimeout(
      () => controller.abort(new Error('deadline')),
      request.limits.maxStreamDurationMs,
    );
    let timedOut = false;
    const markTimeout = () => {
      timedOut = true;
    };
    const deadlineWatcher = setTimeout(markTimeout, request.limits.maxStreamDurationMs);

    const filter = createReasoningFilter();
    const citations = new Map<string, EngineCitation>();
    let visible = '';

    try {
      const response = await this.#fetch(
        `${this.#config.baseUrl}/api/v1/workspace/${this.#config.workspaceSlug}/stream-chat`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            message: this.#renderTurns(request),
            mode: 'query',
            sessionId: request.conversationRef,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok || !response.body) {
        yield this.#error(categoryForStatus(response.status), `vendor status ${response.status}`);
        return;
      }

      for await (const frame of readSseFrames(response.body)) {
        if (frame.error) {
          yield this.#error('unavailable', 'vendor reported a stream error');
          return;
        }

        for (const citation of this.#citationsFrom(frame.sources)) {
          if (citations.has(citation.sourceId)) continue;
          citations.set(citation.sourceId, citation);
          yield { type: 'citation', citation };
        }

        if (typeof frame.textResponse === 'string' && frame.textResponse.length > 0) {
          const text = filter.push(frame.textResponse);
          if (text) {
            visible += text;
            yield { type: 'token', text };
          }
        }

        // Deliberately NOT `if (frame.close) break`. This vendor sets close on
        // the last text chunk and then sends the citations in a separate
        // finalize frame, so leaving at the first close flag discards them.
        if (frame.type === 'finalizeResponseStream') break;
      }

      const tail = filter.end();
      if (tail) {
        visible += tail;
        yield { type: 'token', text: tail };
      }

      if (visible.trim().length === 0) {
        // ADR-002 §7: a reasoning model can spend its whole budget thinking and
        // return nothing visible. That is a failed answer, not an empty one —
        // reporting success shows the visitor a blank bubble.
        yield this.#error('content_filtered', 'engine produced no visible answer');
        return;
      }

      yield { type: 'final', text: visible, citations: [...citations.values()] };
    } catch (error) {
      if (timedOut || (error as Error)?.message === 'deadline') {
        yield this.#error('timeout', 'stream exceeded its duration limit');
        return;
      }
      if (signal.aborted) return;
      yield this.#error('transient', 'stream failed');
    } finally {
      clearTimeout(deadline);
      clearTimeout(deadlineWatcher);
      signal.removeEventListener('abort', onAbort);
      this.#inFlight.delete(handle.operationId);
    }
  }

  /**
   * Only a run this process is streaming can be stopped, because cancellation
   * in this protocol IS closing the connection. Anything else is reported as
   * unknown rather than pretended to be stopped — see `supportsOutOfBandStop`.
   */
  async cancelRun(handle: EngineRunHandle): Promise<EngineCancelResult> {
    const controller = this.#inFlight.get(handle.operationId);
    if (controller) {
      controller.abort();
      this.#inFlight.delete(handle.operationId);
      return 'stopped';
    }
    if (this.#pending.delete(handle.operationId)) return 'stopped';
    return 'unknown_run';
  }

  async health(): Promise<EngineHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await this.#fetch(`${this.#config.baseUrl}/api/ping`, {
        signal: AbortSignal.timeout(5_000),
      });
      return { status: res.ok ? 'live' : 'degraded', checkedAt };
    } catch {
      return { status: 'disabled', checkedAt };
    }
  }

  async attestKnowledgeCredential(): Promise<KnowledgeAttestation> {
    return {
      // A hash, never the key. SECURITY.md §4 wants the identity of the
      // credential that is serving, not its value.
      credentialId: createHash('sha256').update(this.#config.apiKey).digest('hex').slice(0, 32),
      rotationCounter: this.#config.rotationCounter ?? 0,
      spaceId: this.#config.workspaceSlug,
    };
  }

  #error(category: EngineErrorCategory, safeDetail: string): EngineEvent {
    const error = new EngineError(category, { safeDetail });
    return { type: 'error', category, retriable: error.retriable, safeDetail };
  }

  /** The vendor takes one message, so prior turns are rendered as context. */
  #renderTurns(request: EngineRunRequest): string {
    const turns = request.turns;
    const last = turns.at(-1);
    if (!last) return '';
    if (turns.length === 1) return last.text;
    const history = turns
      .slice(0, -1)
      .map((t) => `${t.role === 'visitor' ? 'Customer' : 'Assistant'}: ${t.text}`)
      .join('\n');
    return `Previous conversation:\n${history}\n\nCustomer's current question: ${last.text}`;
  }

  #citationsFrom(sources: VendorSource[] | undefined): EngineCitation[] {
    if (!Array.isArray(sources)) return [];
    const now = new Date().toISOString();
    return sources
      .filter((s) => s && (s.id || s.title))
      .map((s) => {
        const url = s.docSource ?? s.url;
        const snippet = stripDocumentMetadata(s.text);
        return {
          // The PAGE, not the chunk. Retrieval hands back several chunks of one
          // document; citing each one sends the visitor to the same page three
          // times. The chunk id is a vendor-internal handle anyway, which the
          // port explicitly says a sourceId must not be.
          sourceId: String(s.docSource ?? s.title ?? s.id),
          // Prefer the human description supplied at ingest. The raw title is the
          // storage filename, and "en-us-headphones.txt" is not a citation a
          // customer can act on.
          title: String(s.description ?? s.title ?? s.id),
          retrievedAt: parseVendorDate(s.published) ?? now,
          // Spread rather than assign undefined: the workspace runs with
          // exactOptionalPropertyTypes, where an explicit undefined is not the
          // same as an absent key.
          ...(url ? { url } : {}),
          ...(snippet ? { snippet } : {}),
        };
      });
  }
}

/** The vendor prefixes chunk text with a metadata block that is not prose. */
function stripDocumentMetadata(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.replace(/<document_metadata>[\s\S]*?<\/document_metadata>/g, '').trim() || undefined;
}

function parseVendorDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** One SSE block to a frame, or null when it is empty or unparseable. */
function parseSseFrame(raw: string): VendorFrame | null {
  const payload = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as VendorFrame;
  } catch {
    // Skip. Losing one fragment beats ending the answer.
    return null;
  }
}

/**
 * Parse an SSE body into frames.
 *
 * A malformed frame is skipped rather than thrown: one bad frame mid-answer
 * should cost that fragment, not the whole conversation.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<VendorFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush a trailing frame that arrived without its blank-line
        // terminator. The vendor ends the response immediately after its final
        // frame, and that frame is the one carrying every source — requiring
        // the separator silently costs all citations.
        const frame = parseSseFrame(buffer);
        if (frame) yield frame;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE frame split
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = parseSseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
