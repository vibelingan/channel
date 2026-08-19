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
 */

import type { ServerResponse } from 'node:http';
import type { ConversationEngine, EngineTurn } from '@vibelingan-channel/ai-engine';

/** A public endpoint takes a bounded message or none at all. */
const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_TURNS = 20;

export interface ChatRequest {
  message: string;
  history: EngineTurn[];
}

export type ParseResult = { ok: true; value: ChatRequest } | { ok: false; error: string };

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

  const { message, history } = parsed as { message?: unknown; history?: unknown };
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { ok: false, error: 'message is required' };
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message exceeds ${MAX_MESSAGE_CHARS} characters` };
  }

  const turns: EngineTurn[] = [];
  if (history !== undefined) {
    if (!Array.isArray(history)) return { ok: false, error: 'history must be an array' };
    if (history.length > MAX_HISTORY_TURNS) return { ok: false, error: 'history is too long' };
    for (const entry of history) {
      const turn = entry as { role?: unknown; text?: unknown };
      // Only the two roles the port defines. Accepting anything else would let
      // a caller post a 'system' turn and rewrite the assistant's instructions
      // from the browser.
      if (turn.role !== 'visitor' && turn.role !== 'assistant') {
        return { ok: false, error: 'history role must be visitor or assistant' };
      }
      if (typeof turn.text !== 'string' || turn.text.length > MAX_MESSAGE_CHARS) {
        return { ok: false, error: 'history text is missing or too long' };
      }
      turns.push({ role: turn.role, text: turn.text });
    }
  }

  return { ok: true, value: { message: message.trim(), history: turns } };
}

export interface StreamChatOptions {
  engine: ConversationEngine;
  request: ChatRequest;
  res: ServerResponse;
  signal: AbortSignal;
  limits?: { maxOutputTokens: number; maxStreamDurationMs: number };
}

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function streamChatToResponse(options: StreamChatOptions): Promise<void> {
  const { engine, request, res, signal } = options;
  const limits = {
    // Real headroom, not a tight cap: these are reasoning models and the
    // reasoning is billed inside this budget. Too small and the visitor gets a
    // blank answer with no error at all (ADR-002 §7).
    maxOutputTokens: options.limits?.maxOutputTokens ?? 1_500,
    maxStreamDurationMs: options.limits?.maxStreamDurationMs ?? 120_000,
    maxToolCalls: 0,
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Proxies that buffer will hold the whole answer and deliver it at once,
    // which turns a streaming assistant into a slow non-streaming one.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const turns: EngineTurn[] = [...request.history, { role: 'visitor', text: request.message }];

  try {
    const handle = await engine.createRun(
      {
        operationId: crypto.randomUUID(),
        conversationRef: crypto.randomUUID(),
        turns,
        profileId: 'public-sales-v1',
        locale: 'en-US',
        limits,
      },
      signal,
    );

    for await (const event of engine.streamRun(handle, signal)) {
      if (signal.aborted) break;
      // Events are forwarded as-is because the port's events are ALREADY the
      // client contract: token, citation, final, error. The vendor run id lives
      // on the handle and deliberately never enters this stream.
      sse(res, event);
      if (event.type === 'final' || event.type === 'error') break;
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
    res.end();
  }
}
