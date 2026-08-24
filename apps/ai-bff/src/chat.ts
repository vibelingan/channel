/**
 * The conversation route — the thinnest slice that lets a person hold a
 * conversation with the assistant locally.
 *
 * SCOPE, stated plainly so nobody mistakes this for the finished design: this
 * calls the engine and streams the answer back. It does NOT yet implement
 * LLD-001's run lifecycle — no run row, no ordered event log, no authorization
 * epoch, no human takeover. Those are MIU 2c/5b/5c. Everything here is written
 * so that adding them is additive: the engine is injected, the events are
 * already the port's normalized events, and nothing vendor-shaped is visible.
 *
 * TRUST BOUNDARY: the client supplies exactly two things — a conversation id it
 * was given, and a new visitor message. It may not assert what the assistant
 * previously said, and it may not manufacture turns. See `conversations.ts`.
 */

import type { ServerResponse } from 'node:http';
import type { ConversationEngine, EngineTurn } from '@vibelingan-channel/ai-engine';
import type { ConversationStore } from './conversations.ts';
import { classifyCommitmentRequest, templateFor } from './policy/commitments.ts';
import { topicForCommitments, ungroundedCommitments } from './policy/grounding.ts';

/** A public endpoint takes a bounded message or none at all. */
const MAX_MESSAGE_CHARS = 2_000;

/** Conversation ids are ours, and they are UUIDs. Anything else is not one. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatRequest {
  message: string;
  conversationId?: string;
}

export type ParseResult = { ok: true; value: ChatRequest } | { ok: false; error: string };

/**
 * Break turn labels a visitor typed into their own message.
 *
 * The engine renders history as `Customer: …` / `Assistant: …` lines, so a
 * message containing a line that starts `Assistant:` can graft a fabricated
 * turn into the prompt. Replacing the colon keeps the sentence readable while
 * removing the shape the model reads as a speaker change.
 *
 * This is defence in depth, not the structural fix. The structural fix is to
 * send roles as protocol fields rather than as text — recorded as follow-up,
 * because this vendor's retrieval endpoint takes a single string and its
 * message-array endpoint has not been shown to return citations.
 */
export function neutralizeRoleLabels(text: string): string {
  return text.replace(/^([ \t>]*)(assistant|system|customer|user|human|ai)[ \t]*:/gim, '$1$2 -');
}

export function parseChatRequest(body: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: 'body is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'body must be an object' };
  }

  const { message, conversationId } = parsed as { message?: unknown; conversationId?: unknown };
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { ok: false, error: 'message is required' };
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message exceeds ${MAX_MESSAGE_CHARS} characters` };
  }

  if (conversationId !== undefined) {
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) {
      return { ok: false, error: 'conversationId is not a valid conversation reference' };
    }
    return { ok: true, value: { message: message.trim(), conversationId } };
  }

  return { ok: true, value: { message: message.trim() } };
}

export interface StreamChatOptions {
  engine: ConversationEngine;
  request: ChatRequest;
  conversations: ConversationStore;
  res: ServerResponse;
  signal: AbortSignal;
  limits?: { maxDeliveredOutputUnits: number; maxStreamDurationMs: number };
}

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function streamChatToResponse(options: StreamChatOptions): Promise<void> {
  const { engine, request, conversations, res, signal } = options;
  const limits = {
    // Real headroom, not a tight cap: these are reasoning models and the
    // reasoning is billed inside this budget. Too small and the visitor gets a
    // blank answer with no error at all (ADR-002 §7).
    maxDeliveredOutputUnits: options.limits?.maxDeliveredOutputUnits ?? 1_500,
    maxStreamDurationMs: options.limits?.maxStreamDurationMs ?? 120_000,
    maxToolCalls: 0,
  };

  // An id the client did not get from us — expired, guessed, or invented — is
  // not an error. It starts a new conversation, which is what the visitor sees
  // anyway, and avoids handing out an oracle for which ids exist.
  const existing =
    request.conversationId && conversations.has(request.conversationId)
      ? request.conversationId
      : null;
  const conversationId = existing ?? conversations.create();

  // The store is full and every conversation in it is mid-answer. Refuse HERE,
  // before the engine is called: starting a run whose answer has nowhere to be
  // recorded would spend tokens producing something that is then discarded.
  if (conversationId === null) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: 'AT_CAPACITY',
          message:
            'The assistant is handling as many conversations as it can. Please try again shortly.',
        },
      }),
    );
    return;
  }

  // Refused before any streaming header is written, so the caller gets an
  // ordinary status rather than an error buried inside a stream it is already
  // reading.
  if (!conversations.tryBeginTurn(conversationId)) {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: 'CONVERSATION_BUSY',
          message: 'This conversation already has an answer in progress.',
        },
      }),
    );
    return;
  }

  const visitorTurn: EngineTurn = {
    role: 'visitor',
    text: neutralizeRoleLabels(request.message),
  };
  const priorTurns = conversations.turns(conversationId);

  // A question asking for a price, a discount, a delivery date or a
  // certification is answered by US, from a fixed template. The engine is never
  // called, so there is no generated text that could commit the company to
  // anything — see policy/commitments.ts for why detecting a bad ANSWER was the
  // wrong boundary.
  const policy = classifyCommitmentRequest(request.message);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Proxies that buffer will hold the whole answer and deliver it at once,
    // which turns a streaming assistant into a slow non-streaming one.
    'x-accel-buffering': 'no',
    // How the client continues this conversation. It is an opaque handle, not
    // a container for history.
    'x-conversation-id': conversationId,
    // The structured outcome. Something to assert instead of prose to parse.
    'x-policy-outcome': policy ? `refused:${policy.topic}` : 'answered-by-engine',
  });
  res.flushHeaders?.();

  if (policy) {
    sse(res, { type: 'token', text: policy.template });
    sse(res, { type: 'final', text: policy.template, citations: [] });
    conversations.append(conversationId, visitorTurn);
    conversations.append(conversationId, { role: 'assistant', text: policy.template });
    conversations.endTurn(conversationId);
    res.end();
    return;
  }

  /**
   * The answer, but ONLY once the engine has said it finished.
   *
   * Deliberately not "whatever tokens arrived". A stream that emitted
   * "We approved 40" and then failed has not said anything — recording that
   * fragment would make a truncated sentence into a trusted prior statement of
   * the company's, replayed as context on the customer's next question. That is
   * the same failure as accepting history from the client, sourced from our own
   * side instead, and it is why the check is the terminal EVENT rather than the
   * presence of text.
   */
  let completedAnswer: string | null = null;
  let terminated = false;
  /** Set when the grounding gate replaced the model's answer. */
  let groundingRefusal: string | null = null;

  try {
    const handle = await engine.createRun(
      {
        operationId: crypto.randomUUID(),
        conversationRef: conversationId,
        turns: [...priorTurns, visitorTurn],
        profileId: 'public-sales-v1',
        locale: 'en-US',
        limits,
      },
      signal,
    );

    for await (const event of engine.streamRun(handle, signal)) {
      if (signal.aborted) break;
      // One terminal event per stream. A second `final` after the first is an
      // engine defect, and forwarding it would let the client see two answers.
      if (terminated) break;

      // Events are forwarded as-is because the port's events are ALREADY the
      // client contract: token, citation, final, error. The vendor run id lives
      // on the handle and deliberately never enters this stream.
      //
      // `final` is NOT forwarded here: it goes through the grounding gate below,
      // which may replace it.
      if (event.type !== 'final') sse(res, event);

      if (event.type === 'final') {
        // THE ANSWER-SIDE GATE. Ask-side interception only catches recognised
        // phrasings; this catches an invented price, discount, date or
        // certification whatever sentence carries it, by requiring the concrete
        // value to appear in the sources the answer was built from.
        const invented = ungroundedCommitments(event.text, event.citations);
        if (invented.length > 0) {
          const replacement = templateFor(topicForCommitments(invented));
          const topic = topicForCommitments(invented);
          sse(res, { type: 'token', text: replacement });
          sse(res, { type: 'final', text: replacement, citations: [] });
          // The outcome header was written before the stream opened, so it
          // cannot report a decision made mid-answer. This trailing event
          // carries it instead — route-level, not one of the port's events.
          sse(res, {
            type: 'policy',
            outcome: `refused:${topic}`,
            reason: 'ungrounded-commitment',
            values: invented.map((value) => value.kind),
          });
          completedAnswer = replacement;
          groundingRefusal = topic;
          terminated = true;
          break;
        }
        sse(res, event);
        completedAnswer = event.text;
        terminated = true;
        break;
      }
      if (event.type === 'error') {
        terminated = true;
        break;
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      sse(res, {
        type: 'error',
        category: 'transient',
        retriable: true,
        safeDetail: error instanceof Error ? error.name : 'stream failed',
      });
    }
  } finally {
    // The question was genuinely asked, so it is recorded whatever happened to
    // the answer. History then reads as "customer asked X, we did not answer",
    // which is what actually occurred.
    conversations.append(conversationId, visitorTurn);
    // The answer is recorded only if the engine declared it complete. Errors,
    // timeouts, aborts, exceptions and truncated streams all leave this null.
    if (completedAnswer !== null && completedAnswer.trim().length > 0) {
      conversations.append(conversationId, { role: 'assistant', text: completedAnswer });
    }
    conversations.endTurn(conversationId);
    res.end();
  }
}

/** Exposed for tests: did the grounding gate replace an answer on this run? */
export type GroundingOutcome = string | null;
