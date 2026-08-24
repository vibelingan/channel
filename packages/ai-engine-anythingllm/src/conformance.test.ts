/**
 * The AnythingLLM adapter against the SHARED conformance suite.
 *
 * LLD-002 §9: every adapter runs this, including the fake. An adapter that only
 * has vendor-specific tests has been checked against its author's idea of the
 * vendor, not against the port other code depends on.
 *
 * The vendor is scripted through the injected `fetchImpl`, so failures a real
 * server produces rarely — a 500 mid-answer, a socket reset, a frame that is not
 * JSON, an answer that never stops — are reachable deterministically.
 */

import test from 'node:test';
import { type ConformanceHarness, runConformanceSuite } from '@vibelingan-channel/ai-engine';
import { AnythingLlmEngine } from './engine.ts';

type Script =
  | { kind: 'normal' }
  | { kind: 'http_500' }
  | { kind: 'socket_reset' }
  | { kind: 'malformed_frame' }
  | { kind: 'timeout' }
  | { kind: 'overlong' }
  | { kind: 'unabortable_silence' };

/** Per-engine scripting state, keyed by the instance the suite hands back. */
const scripts = new WeakMap<object, { script: Script }>();

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const CHUNK = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'textResponseChunk',
  textResponse: text,
  sources: [],
  close: false,
  error: false,
  ...extra,
});

const FINALIZE = {
  type: 'finalizeResponseStream',
  close: true,
  error: false,
  sources: [
    {
      id: 'chunk-1',
      title: 'en-us-headphones.txt',
      description: 'Headphones product line',
      docSource: '/headphones',
      text: 'MOQ from 500 units',
      published: '8/19/2026, 7:08:00 AM',
    },
  ],
};

function bodyFor(script: Script): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  if (script.kind === 'socket_reset') {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse(CHUNK('Our MOQ '))));
        controller.error(new Error('socket hang up'));
      },
    });
  }
  if (script.kind === 'malformed_frame') {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse(CHUNK('Our MOQ '))));
        controller.enqueue(encoder.encode('data: {this is not json\n\n'));
        controller.enqueue(encoder.encode(sse(FINALIZE)));
        controller.close();
      },
    });
  }
  if (script.kind === 'unabortable_silence') {
    // Yields nothing, and the caller below deliberately does NOT wire abort to
    // it — a vendor that accepts the connection and then goes quiet.
    return new ReadableStream({ start() {} });
  }
  if (script.kind === 'timeout') {
    // Emits nothing and never closes: the adapter's own deadline is the only
    // thing that can end this.
    return new ReadableStream({ start() {} });
  }
  if (script.kind === 'overlong') {
    return new ReadableStream({
      start(controller) {
        // Far more output than the suite's 256-token budget allows.
        for (let i = 0; i < 400; i++) {
          controller.enqueue(
            encoder.encode(sse(CHUNK(`sentence number ${i} of a runaway answer. `))),
          );
        }
        controller.enqueue(encoder.encode(sse(FINALIZE)));
        controller.close();
      },
    });
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse(CHUNK('Our MOQ '))));
      controller.enqueue(encoder.encode(sse(CHUNK('is 500 units.', { close: true }))));
      controller.enqueue(encoder.encode(sse(FINALIZE)));
      controller.close();
    },
  });
}

function createEngine(): AnythingLlmEngine {
  const state = { script: { kind: 'normal' } as Script };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/ping')) {
      return new Response(JSON.stringify({ online: true }), { status: 200 });
    }
    if (state.script.kind === 'http_500') {
      return new Response(JSON.stringify({ error: 'scripted' }), { status: 500 });
    }
    const body = bodyFor(state.script);
    // Honour abort so the suite's cancellation tests mean something — EXCEPT in
    // the scenario whose whole point is a transport that ignores it.
    const signal = state.script.kind === 'unabortable_silence' ? undefined : init?.signal;
    if (signal) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      signal.addEventListener('abort', () => body.cancel().catch(() => undefined), { once: true });
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const engine = new AnythingLlmEngine({
    baseUrl: 'http://vendor.invalid',
    apiKey: 'conformance-key',
    workspaceSlug: 'conformance-workspace',
    engineVersion: '0.0.0-conformance',
    fetchImpl,
  });
  scripts.set(engine, state);
  return engine;
}

function scriptOf(engine: object): { script: Script } {
  const state = scripts.get(engine);
  if (!state) throw new Error('engine was not created by this harness');
  return state;
}

const harness: ConformanceHarness = {
  create: () => createEngine(),

  scriptVendorFailure(engine, kind) {
    scriptOf(engine).script = { kind };
  },

  scriptTimeout(engine) {
    scriptOf(engine).script = { kind: 'timeout' };
  },

  scriptOverlongOutput(engine) {
    scriptOf(engine).script = { kind: 'overlong' };
  },

  scriptUnabortableSilence(engine) {
    scriptOf(engine).script = { kind: 'unabortable_silence' };
  },

  rotateKnowledgeCredential(engine) {
    (engine as AnythingLlmEngine).rotateKnowledgeCredential('a-different-key');
  },

  /**
   * Required because this engine has no native idempotent create. The property
   * is carried by the handle being DERIVED from the operationId rather than
   * issued by the vendor, so a process that dies before recording the handle
   * recomputes the identical one.
   */
  scriptCrashBetweenCallAndRecord(engine) {
    (engine as AnythingLlmEngine).forgetPendingRuns();
  },
};

test('conformance harness sanity: the scripted vendor answers normally', async () => {
  const engine = harness.create();
  const handle = await engine.createRun(
    {
      operationId: '00000000-0000-4000-8000-0000000000ff',
      conversationRef: 'sanity',
      turns: [{ role: 'visitor', text: 'MOQ?' }],
      profileId: 'public-sales-v1',
      locale: 'en-US',
      limits: { maxDeliveredOutputUnits: 256, maxStreamDurationMs: 5_000, maxToolCalls: 0 },
    },
    new AbortController().signal,
  );
  const types: string[] = [];
  for await (const event of engine.streamRun(handle, new AbortController().signal)) {
    types.push(event.type);
  }
  if (!types.includes('final')) throw new Error(`no final event; got ${types.join(',')}`);
});

runConformanceSuite('anythingllm', harness);
