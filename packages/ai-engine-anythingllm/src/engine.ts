/**
 * `ConversationEngine` adapter for AnythingLLM (ADR-002).
 *
 * Everything vendor-shaped is confined to this file. The BFF sees only the port
 * — which is what makes ADR-002's "the exit is already built" claim true rather
 * than aspirational.
 */

import { createHash } from 'node:crypto';
import {
  type EngineCapabilities,
  type EngineProvenance,
  assertProvenance,
} from '@vibelingan-channel/ai-engine/capabilities';
import { EngineError, type EngineErrorCategory } from '@vibelingan-channel/ai-engine/errors';
import type {
  ConversationEngine,
  EngineCancelResult,
  EngineCitation,
  EngineEvent,
  EngineHealth,
  EngineRunHandle,
  EngineRunRequest,
  KnowledgeAttestation,
} from '@vibelingan-channel/ai-engine/port';
import { createReasoningFilter } from './reasoning.ts';
import { inspectWorkspaceToolSurface } from './workspace-inspection.mjs';

export { inspectWorkspaceToolSurface };

/** Result of asking the engine what it is permitted to do on our behalf. */
export interface ToolSurface {
  /** False when the engine could not be reached — unknown, not proven safe. */
  known: boolean;
  enabled: boolean;
  /** Short, operator-facing, never credential-shaped. */
  detail: string;
}

export interface AnythingLlmEngineConfig {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
  /** Pinned vendor release, recorded on every run row for incident scoping. */
  engineVersion: string;
  provenance?: EngineProvenance;
  /** Operator assertion from a successful citation-bearing probe. */
  citationsVerified?: boolean;
  /** Bumped whenever the knowledge credential changes. */
  credentialRotationCounter?: number;
  /** Development-only escape hatch for a bounded probe on remote HTTP. */
  allowInsecureRemoteHttp?: boolean;
  /** Bumped by whoever rotates the key, so a swap is visible in attestation. */
  rotationCounter?: number;
  /**
   * The workspace's own generated-token ceiling — for AnythingLLM, the
   * `GENERIC_OPEN_AI_MAX_TOKENS` its provider is configured with.
   *
   * This is the ONLY number the vendor honours per answer. Probed on the
   * running instance: `max_tokens`, `maxTokens` and `maxOutputTokens` in the
   * request body are all accepted with HTTP 200 and all ignored, so a per-run
   * limit cannot be sent. Surfaced so the cost model bounds what is generated
   * rather than what we happen to receive.
   */
  vendorMaxOutputTokens?: number;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

/** Vendor SSE frame. Only the fields we depend on are named. */
interface VendorFrame {
  type?: string;
  textResponse?: string | null;
  sources?: VendorSource[];
  close?: boolean;
  error?: string | boolean | null;
  /** Set when the frame could not be parsed. Surfaced, never skipped. */
  malformed?: true;
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

/** Code points per output unit for scripts that tokenize several characters at a time. */
const ALPHABETIC_CHARS_PER_UNIT = 4;

/**
 * Scripts with evidence of multi-character tokens: Latin and its extensions,
 * Greek, Cyrillic, and general punctuation.
 *
 * This is an ALLOWLIST on purpose. The previous version used a numeric cutoff —
 * "anything above U+2E80 is dense" — and silently gave Thai (U+0E00) and
 * Devanagari (U+0900) the cheap Latin rate while a comment claimed to cover
 * them: 80 Thai code points estimated at 20 units, the same defect shape as the
 * original CJK bug, in two scripts the comment named. With an allowlist, a
 * script nobody has classified is charged the expensive rate rather than the
 * cheap one, so the next unlisted script under-serves the customer instead of
 * over-spending the budget.
 */
const ALPHABETIC_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x024f], // Basic Latin, Latin-1 Supplement, Latin Extended-A and -B
  [0x0370, 0x03ff], // Greek and Coptic
  [0x0400, 0x04ff], // Cyrillic
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // General punctuation: dashes, curly quotes, ellipsis
];

function isAlphabeticCodePoint(code: number): boolean {
  return ALPHABETIC_RANGES.some(([low, high]) => code >= low && code <= high);
}

/**
 * Estimate the OUTPUT UNITS a piece of text costs.
 *
 * Deliberately not called a token count. This protocol reports real usage only
 * in its final frame, far too late to stop a runaway answer, so the budget is
 * enforced on an estimate and the name says so. `maxDeliveredOutputUnits` is therefore
 * an approximate ceiling, not a guarantee — the durable fix is a tokenizer for
 * the configured model family, which belongs with the engine that has one.
 *
 * A flat four-characters-per-unit is an ENGLISH rule and this assistant answers
 * multilingual customers: 80 Chinese characters once passed a 20-unit budget
 * because 80/4 read as 20, while common tokenizers charge close to one token per
 * CJK character.
 *
 * Biased to trip early. Anything outside the alphabetic allowlist — CJK, Kana,
 * Hangul, Thai, Devanagari, Arabic, Hebrew, emoji — is charged a full unit per
 * code point.
 */
export function estimateOutputUnits(text: string): number {
  let dense = 0;
  let alphabetic = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (isAlphabeticCodePoint(code)) {
      alphabetic += 1;
    } else {
      dense += 1;
    }
  }
  return dense + Math.ceil(alphabetic / ALPHABETIC_CHARS_PER_UNIT);
}

/** How many finished runs are remembered, so `cancelRun` can distinguish
 * "already finished" from "never existed" without growing without bound. */
const REMEMBERED_RUNS = 1_000;

/**
 * A single expiry shared by every await in one run.
 *
 * Two separate timers on the same duration, with the winner identified by
 * matching an error message, is what this replaces. Identity comparison against
 * one sentinel is deterministic; message matching is not, and cannot tell a
 * caller's abort from an expiry that happened to phrase itself the same way.
 */
/** Resolution sentinel for "the caller aborted", distinct from any real value. */
const ABORTED = Symbol('aborted');

class Deadline {
  readonly #expiry: symbol = Symbol('deadline');
  readonly #timer: ReturnType<typeof setTimeout>;
  #rejectExpired: ((reason: unknown) => void) | undefined;
  readonly #expired: Promise<never>;

  constructor(ms: number, onExpire?: () => void) {
    this.#expired = new Promise<never>((_, reject) => {
      this.#rejectExpired = reject;
    });
    // Nothing ever awaits #expired on its own, so an unhandled rejection would
    // be reported if it fired with no racer attached.
    this.#expired.catch(() => undefined);
    this.#timer = setTimeout(() => {
      // Tear the transport down as well as rejecting. Rejecting alone leaves
      // the underlying read pending, and a pending read makes the generator's
      // own cleanup unable to complete — which is how a deadline meant to stop
      // a hang became a hang.
      onExpire?.();
      this.#rejectExpired?.(this.#expiry);
    }, ms);
  }

  /** Resolve `work`, or reject with this deadline's sentinel when time runs out. */
  race<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.#expired]);
  }

  /**
   * As `race`, but a caller abort also wins — so a hung connect does not hold
   * the run until the deadline. Rejects with an `AbortError` the caller's own
   * `signal.aborted` check then recognises.
   */
  raceWithAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    return Promise.race([work, this.#expired, aborted]).finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
  }

  /**
   * Re-yield `source`, applying the same deadline to every step — and ending
   * immediately when the caller aborts.
   *
   * The caller's signal has to be one of the racers, not merely something that
   * tells the transport to stop. A transport that ignores abort and then sends
   * nothing leaves the read pending, so cancellation could only take effect
   * when the deadline fired: measured at 401ms for an abort issued at 20ms
   * against a 400ms deadline. A visitor pressing Stop is not asking to wait out
   * the run.
   */
  async *guard<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
    const iterator = source[Symbol.asyncIterator]();
    let onAbort: (() => void) | undefined;
    const abortedEarly: Promise<typeof ABORTED> | null = signal
      ? new Promise((resolve) => {
          if (signal.aborted) return resolve(ABORTED);
          onAbort = () => resolve(ABORTED);
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : null;

    try {
      for (;;) {
        const racers: Promise<IteratorResult<T> | typeof ABORTED>[] = [
          iterator.next(),
          this.#expired,
        ];
        if (abortedEarly) racers.push(abortedEarly);
        const next = await Promise.race(racers);
        if (next === ABORTED) return;
        if (next.done) return;
        yield next.value;
      }
    } finally {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      // NOT awaited. A generator suspended on a read that never settles cannot
      // finish returning, so awaiting its cleanup here would block forever on
      // exactly the failure this class exists to end.
      void iterator.return?.().catch(() => undefined);
    }
  }

  expired(error: unknown): boolean {
    return error === this.#expiry;
  }

  clear(): void {
    clearTimeout(this.#timer);
  }
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

  #config: AnythingLlmEngineConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  /** Pending request bodies, keyed by operationId, awaiting their stream. */
  readonly #pending = new Map<string, EngineRunRequest>();
  /** In-flight streams this process owns, so it can abort what it holds. */
  readonly #inFlight = new Map<string, AbortController>();
  /**
   * Runs that reached a terminal state, newest last. Bounded, because an
   * unbounded record of every run this process ever served is a slow leak.
   */
  readonly #finished = new Set<string>();

  constructor(config: AnythingLlmEngineConfig) {
    if (!config.apiKey) throw new Error('AnythingLLM API key is required');
    if (!config.workspaceSlug) throw new Error('AnythingLLM workspace slug is required');
    this.#config = {
      ...config,
      baseUrl: safeBaseUrl(config.baseUrl, config.allowInsecureRemoteHttp === true),
    };
    this.#fetch = config.fetchImpl ?? fetch;
    this.#now = config.now ?? (() => new Date().toISOString());
    this.capabilities = {
      engineId: 'anythingllm',
      engineVersion: config.engineVersion,
      ...(config.provenance ? { provenance: assertProvenance(config.provenance) } : {}),
      // The chat API creates and answers in one call, so there is no run to
      // create idempotently. LLD-001 §7's operation-id mapping layer is the
      // compensation, and the startup check enforces that it is configured.
      supportsIdempotentCreate: false,
      supportsRunLookupByOperationId: false,
      // The owner aborts its own connection — see LLD-002 §7.1.
      supportsStop: true,
      // No stop-by-run-id exists in this protocol family. ADR-002 §3.
      supportsOutOfBandStop: false,
      supportsCitations: config.citationsVerified === true,
      ...(config.vendorMaxOutputTokens
        ? { vendorMaxOutputTokens: config.vendorMaxOutputTokens }
        : {}),
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

    // ONE deadline, one timer, one identity to compare against.
    //
    // The previous version ran two timers on the same duration and decided
    // which had fired by matching an error MESSAGE. It also assumed aborting
    // the fetch signal would end the read — so a vendor that accepts a
    // connection and then says nothing at all hung the worker forever, because
    // nothing was watching the read itself. The deadline now races every read,
    // which holds whether or not the transport honours abort.
    const deadline = new Deadline(request.limits.maxStreamDurationMs, () => controller.abort());

    const filter = createReasoningFilter();
    const citations = new Map<string, EngineCitation>();
    // See `estimateTokens`: approximate, script-aware, and biased to trip early.
    // See `estimateOutputUnits`: an approximate ceiling, script-aware, biased
    // to trip early. Not a token guarantee.
    const maxOutputUnits = request.limits.maxDeliveredOutputUnits;
    let producedUnits = 0;
    let visible = '';
    let sawTerminalFrame = false;

    try {
      const response = await deadline.raceWithAbort(
        signal,
        this.#fetch(
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
        ),
      );

      if (!response.ok || !response.body) {
        yield this.#error(categoryForStatus(response.status), `vendor status ${response.status}`);
        return;
      }

      let overlong = false;

      for await (const frame of deadline.guard(readSseFrames(response.body), signal)) {
        // Checked per frame, not left to the transport. Frames already buffered
        // in the stream keep arriving after an abort, so without this the
        // caller's cancellation would be honoured only once the buffer drained.
        if (signal.aborted) return;

        if (frame.malformed) {
          // Not skipped. A frame we cannot parse is output we cannot account
          // for, and continuing would hand the visitor an answer with a hole in
          // it that reads as complete.
          yield this.#error('transient', 'vendor sent a frame that could not be parsed');
          return;
        }
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
          // Counted RAW, before the reasoning filter. The models bill their
          // private reasoning inside the same completion budget, so counting
          // only what a visitor sees would let a run spend far past its limit.
          producedUnits += estimateOutputUnits(frame.textResponse);
          if (producedUnits > maxOutputUnits) {
            overlong = true;
            break;
          }
          const text = filter.push(frame.textResponse);
          if (text) {
            visible += text;
            yield { type: 'token', text };
          }
        }

        // Deliberately NOT `if (frame.close) break`. This vendor sets close on
        // the last text chunk and then sends the citations in a separate
        // finalize frame, so leaving at the first close flag discards them.
        if (frame.type === 'finalizeResponseStream' || frame.close === true) {
          sawTerminalFrame = frame.type === 'finalizeResponseStream' || sawTerminalFrame;
        }
        if (frame.type === 'finalizeResponseStream') {
          sawTerminalFrame = true;
          break;
        }
      }

      if (overlong) {
        controller.abort();
        // The taxonomy in LLD-002 §6 has no "limit exceeded" category. This is
        // the least wrong of the closed set and, importantly, non-retriable: an
        // answer that overran once will overrun again, and a retry loop would
        // simply spend the budget twice. Widening the taxonomy is a change to
        // the port and belongs with its owners.
        yield this.#error(
          'invalid_request',
          'engine output exceeded the estimated output budget; raise maxDeliveredOutputUnits or narrow the profile',
        );
        return;
      }

      // A caller who aborted is not owed an error. They asked for it to stop,
      // and reporting "the stream ended early" would turn a visitor pressing
      // Stop into a logged failure and an error bubble on the page.
      if (signal.aborted) return;

      if (!sawTerminalFrame) {
        // The body ended before the engine said it had finished. Emitting a
        // `final` here would record a truncated answer as a complete one.
        yield this.#error('transient', 'stream ended before the engine finished its answer');
        return;
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
      if (deadline.expired(error)) {
        yield this.#error('timeout', 'stream exceeded its duration limit');
        return;
      }
      if (signal.aborted) return;
      yield this.#error('transient', 'stream failed');
    } finally {
      deadline.clear();
      signal.removeEventListener('abort', onAbort);
      this.#inFlight.delete(handle.operationId);
      // Remember that this run reached a terminal state, so a later cancel can
      // say "already finished" rather than "never heard of it". The conformance
      // suite requires that distinction, and it is a real one: an operator
      // cancelling a finished run and an operator cancelling a typo should not
      // get the same answer.
      this.#remember(handle.operationId);
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
      this.#remember(handle.operationId);
      return 'stopped';
    }
    if (this.#pending.delete(handle.operationId)) {
      this.#remember(handle.operationId);
      return 'stopped';
    }
    // A run this process has seen reach an end. Cancelling it again is a
    // no-op that succeeded, which is not the same answer as "no such run" —
    // an operator cancelling a finished run and one cancelling a typo need to
    // be told different things.
    if (this.#finished.has(handle.operationId)) return 'already_finished';
    return 'unknown_run';
  }

  /**
   * Swap the knowledge credential without a restart, moving the attested
   * rotation counter so the change is visible to the startup check that
   * compares "which credential is serving" against the one that was probed.
   */
  rotateKnowledgeCredential(apiKey: string): void {
    if (!apiKey) throw new Error('AnythingLLM API key is required');
    this.#config = {
      ...this.#config,
      apiKey,
      credentialRotationCounter: (this.#config.credentialRotationCounter ?? 1) + 1,
    };
  }

  /**
   * Drop runs that were created but never streamed — what a process crash
   * between the create call and recording its handle looks like from inside.
   * Used by the conformance harness; the handle is derived from the
   * operationId, so a replay after this recomputes the identical one.
   */
  forgetPendingRuns(): void {
    this.#pending.clear();
  }

  /**
   * What this engine can do on the assistant's behalf beyond retrieval.
   *
   * The run contract sets `maxToolCalls: 0`, and an adapter cannot enforce that
   * mid-stream for a protocol that never reports tool calls. So it is enforced
   * where it CAN be: the workspace must have no agent surface enabled at all.
   * ADR-002 §4 names this as the same class of gate the Hermes toolset had —
   * "what can this engine actually do on our behalf".
   */
  async inspectToolSurface(): Promise<ToolSurface> {
    try {
      const response = await this.#fetch(
        `${this.#config.baseUrl}/api/v1/workspace/${this.#config.workspaceSlug}`,
        {
          headers: { Authorization: `Bearer ${this.#config.apiKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok)
        return { known: false, enabled: false, detail: `status ${response.status}` };
      const body: unknown = await response.json();
      return inspectWorkspaceToolSurface(body);
    } catch {
      // Unreachable is not the same as "tools are on". Report that we could not
      // tell, and let the caller decide.
      return { known: false, enabled: false, detail: 'workspace could not be inspected' };
    }
  }

  async health(): Promise<EngineHealth> {
    const checkedAt = this.#now();
    try {
      const res = await this.#fetch(`${this.#config.baseUrl}/api/v1/auth`, {
        headers: { Authorization: `Bearer ${this.#config.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body: unknown = await res.json().catch(() => null);
      return {
        status: res.ok && isRecord(body) && body.authenticated === true ? 'live' : 'degraded',
        checkedAt,
      };
    } catch {
      return { status: 'degraded', checkedAt };
    }
  }

  async attestKnowledgeCredential(): Promise<KnowledgeAttestation> {
    return {
      // A hash, never the key. SECURITY.md §4 wants the identity of the
      // credential that is serving, not its value.
      credentialId: createHash('sha256').update(this.#config.apiKey).digest('hex').slice(0, 16),
      rotationCounter: this.#config.credentialRotationCounter ?? 1,
      spaceId: this.#config.workspaceSlug,
    };
  }

  #remember(operationId: string): void {
    this.#finished.add(operationId);
    while (this.#finished.size > REMEMBERED_RUNS) {
      const oldest = this.#finished.values().next();
      if (oldest.done) break;
      this.#finished.delete(oldest.value);
    }
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
    const now = this.#now();
    return sources
      .filter((s) => s && (s.id || s.title))
      .map((s) => {
        const provenance = String(s.title ?? s.docSource ?? s.id);
        const url = publicSourceUrl(s.url, s.docSource);
        const snippet = stripDocumentMetadata(s.text);
        const description = s.description?.trim();
        const readerTitle =
          description && description.toLowerCase() !== 'unknown'
            ? description
            : String(s.title ?? s.id);
        return {
          // The PAGE, not the chunk. Retrieval hands back several chunks of one
          // document; citing each one sends the visitor to the same page three
          // times. The chunk id is a vendor-internal handle anyway, which the
          // port explicitly says a sourceId must not be.
          sourceId: provenance,
          // Prefer the human description supplied at ingest. The raw title is the
          // storage filename, and "en-us-headphones.txt" is not a citation a
          // customer can act on.
          title: readerTitle,
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

function publicSourceUrl(...candidates: Array<string | undefined>): string | undefined {
  for (const value of candidates) {
    if (!value) continue;
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      // A vendor description such as "a text file uploaded by the user" is
      // not a URL. Try the next candidate without exposing it as a link.
    }
  }
  return undefined;
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

/**
 * Only loopback is intrinsically local. Everything else must say so.
 *
 * `anythingllm` was on this list, and that was a hostname-shaped hole in a
 * transport control: ANY host resolving that name — a container on a shared
 * network, a DNS entry someone adds, a `/etc/hosts` line — got plaintext, and
 * the bearer this engine sends is an INSTANCE-WIDE developer token that can
 * read system configuration and enumerate workspaces. A control that a name can
 * satisfy is not a control.
 *
 * The Docker compose stack still reaches the engine over http on a private
 * network; it now does so by setting ALLOW_INSECURE_ANYTHINGLLM explicitly,
 * which is auditable, refused in production by FORBIDDEN_ENV_KEYS, and cannot
 * be arrived at by accident.
 */
const INTRINSICALLY_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function safeBaseUrl(value: string, allowInsecure: boolean): string {
  const url = new URL(value);
  const local = INTRINSICALLY_LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowInsecure))) {
    throw new Error('AnythingLLM requires HTTPS for remote endpoints');
  }
  return url.toString().replace(/\/$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function vendorSource(value: unknown): VendorSource | null {
  if (!isRecord(value)) return null;
  const source: VendorSource = {};
  const id = optionalString(value.id);
  const title = optionalString(value.title);
  const description = optionalString(value.description);
  const docSource = optionalString(value.docSource);
  const url = optionalString(value.url);
  const text = optionalString(value.text);
  const published = optionalString(value.published);
  if (id) source.id = id;
  if (title) source.title = title;
  if (description) source.description = description;
  if (docSource) source.docSource = docSource;
  if (url) source.url = url;
  if (text) source.text = text;
  if (published) source.published = published;
  return source;
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
    const parsed: unknown = JSON.parse(payload);
    // Every VendorFrame field is optional, so casting would accept a bare
    // scalar — `42` would become a frame with no text and no sources, i.e. an
    // empty-but-valid one, and the hole would be silent. It matters more now
    // that the production knowledge base is a third-party fork whose frame
    // shape is nobody's contract.
    if (!isRecord(parsed)) {
      return { malformed: true };
    }
    const type = optionalString(parsed.type);
    const textResponse = parsed.textResponse === null ? null : optionalString(parsed.textResponse);
    const close = typeof parsed.close === 'boolean' ? parsed.close : undefined;
    const error =
      parsed.error === null || typeof parsed.error === 'boolean' || typeof parsed.error === 'string'
        ? parsed.error
        : undefined;
    if (
      ('type' in parsed && type === undefined) ||
      ('textResponse' in parsed && textResponse === undefined) ||
      ('close' in parsed && close === undefined) ||
      ('error' in parsed && error === undefined)
    ) {
      return { malformed: true };
    }
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.map(vendorSource).filter((source): source is VendorSource => source !== null)
      : undefined;
    if ('sources' in parsed && !Array.isArray(parsed.sources)) return { malformed: true };
    return {
      ...(type === undefined ? {} : { type }),
      ...(textResponse === undefined ? {} : { textResponse }),
      ...(sources === undefined ? {} : { sources }),
      ...(close === undefined ? {} : { close }),
      ...(error === undefined ? {} : { error }),
    };
  } catch {
    // Reported, not skipped. Silently dropping a fragment hands the visitor an
    // answer with a hole in it that reads as complete — and for a sales
    // assistant, a sentence missing its qualifier is worse than no sentence.
    return { malformed: true };
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
