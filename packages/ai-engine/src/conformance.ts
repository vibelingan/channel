/**
 * The shared conformance suite (LLD-002 §9).
 *
 * Every adapter — including the fake — must pass this. An adapter that cannot
 * is not swappable, whatever its README claims.
 *
 * The suite is exported as a function rather than a test file so each adapter
 * package runs it against its own instance under its own test runner.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { isEngineErrorCategory } from './errors.ts';
import type { ConversationEngine, EngineEvent, EngineRunRequest } from './port.ts';

/**
 * What the suite needs from an adapter in order to exercise failure paths it
 * cannot otherwise reach. An adapter that cannot script a vendor 500 has no way
 * to prove it normalizes one.
 */
export interface ConformanceHarness {
  /** A fresh engine instance. Called once per test — no shared state between cases. */
  create(): ConversationEngine;
  /** Make the next stream fail the way a vendor would: 5xx, socket reset, bad frame. */
  scriptVendorFailure(
    engine: ConversationEngine,
    kind: 'http_500' | 'socket_reset' | 'malformed_frame',
  ): void;
  /** Make the next stream exceed its duration limit. */
  scriptTimeout(engine: ConversationEngine): void;
  /** Make the next stream emit more output than `maxOutputTokens` allows. */
  scriptOverlongOutput(engine: ConversationEngine): void;
  /** Rotate the knowledge credential, so the attestation counter must move. */
  rotateKnowledgeCredential(engine: ConversationEngine): void;
  /**
   * Simulate a crash between the vendor call and recording its handle, then
   * return an engine that replays the same operation. Only required when
   * `supportsIdempotentCreate` is false — see the note on that case below.
   */
  scriptCrashBetweenCallAndRecord?(engine: ConversationEngine): void;

  /**
   * Make the next stream produce NO frames and ignore transport-level abort —
   * a vendor that accepts the connection and then goes silent.
   *
   * Optional only because an in-process fake has no transport to ignore
   * anything. Every adapter that talks over a network must supply it: without
   * it, `supportsStop` is tested against a transport that politely cooperates,
   * which is not the case cancellation exists for.
   */
  scriptUnabortableSilence?(engine: ConversationEngine): void;
}

const SAMPLE_REQUEST: EngineRunRequest = {
  operationId: '00000000-0000-4000-8000-000000000001',
  conversationRef: 'conv-ref-1',
  turns: [{ role: 'visitor', text: 'What is your MOQ?' }],
  profileId: 'public-cs@1',
  locale: 'en',
  limits: { maxOutputTokens: 256, maxStreamDurationMs: 5_000, maxToolCalls: 4 },
};

const EVENT_TYPES = new Set(['token', 'citation', 'final', 'error']);

/** Every key the schema permits, per event type. Anything else is vendor leakage. */
const ALLOWED_KEYS: Record<string, Set<string>> = {
  token: new Set(['type', 'text']),
  citation: new Set(['type', 'citation']),
  final: new Set(['type', 'text', 'citations', 'usage']),
  error: new Set(['type', 'category', 'retriable', 'safeDetail']),
};

const ALLOWED_CITATION_KEYS = new Set(['sourceId', 'title', 'url', 'snippet', 'retrievedAt']);

function assertEventMatchesSchema(event: EngineEvent): void {
  assert.ok(EVENT_TYPES.has(event.type), `unknown event type: ${event.type}`);
  const allowed = ALLOWED_KEYS[event.type];
  assert.ok(allowed, `no key allowlist for event type ${event.type}`);
  for (const key of Object.keys(event)) {
    assert.ok(
      allowed.has(key),
      `event '${event.type}' carries unexpected key '${key}' — unknown vendor fields must be dropped, not passed through`,
    );
  }
  if (event.type === 'error') {
    assert.ok(isEngineErrorCategory(event.category), `not a known category: ${event.category}`);
    assert.equal(typeof event.retriable, 'boolean');
  }
  if (event.type === 'citation') {
    for (const key of Object.keys(event.citation)) {
      assert.ok(ALLOWED_CITATION_KEYS.has(key), `citation carries unexpected key '${key}'`);
    }
  }
}

async function collect(stream: AsyncIterable<EngineEvent>, limit = 1_000): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (events.length >= limit) break;
  }
  return events;
}

/**
 * Run the suite. `label` names the adapter in test output.
 *
 * Note the `supportsIdempotentCreate: false` case: the replay test is NOT
 * skipped there. It becomes mandatory, run against the composed stack, because
 * that is precisely the configuration where a hand-built mapping layer — not a
 * vendor guarantee — is carrying the property.
 */
export function runConformanceSuite(label: string, harness: ConformanceHarness): void {
  const capabilities = harness.create().capabilities;

  test(`${label}: replaying createRun with one operationId yields one run`, async () => {
    const engine = harness.create();
    const controller = new AbortController();
    const first = await engine.createRun(SAMPLE_REQUEST, controller.signal);
    const second = await engine.createRun(SAMPLE_REQUEST, controller.signal);
    assert.deepEqual(second, first, 'a replayed create must return the identical handle');

    if (!capabilities.supportsIdempotentCreate) {
      assert.ok(
        harness.scriptCrashBetweenCallAndRecord,
        'an adapter without native idempotent create must supply the crash harness: ' +
          'the composed mapping layer is the only thing providing this property, ' +
          'so it is the thing that most needs testing',
      );
      const crashed = harness.create();
      const before = await crashed.createRun(SAMPLE_REQUEST, controller.signal);
      harness.scriptCrashBetweenCallAndRecord(crashed);
      const after = await crashed.createRun(SAMPLE_REQUEST, controller.signal);
      assert.deepEqual(
        after,
        before,
        'a crash between call and record must not create a second run',
      );
    }
  });

  test(`${label}: cancelRun is idempotent`, async () => {
    const engine = harness.create();
    const handle = await engine.createRun(SAMPLE_REQUEST, new AbortController().signal);
    const first = await engine.cancelRun(handle);
    const second = await engine.cancelRun(handle);
    assert.ok(['stopped', 'already_finished'].includes(first), `unexpected: ${first}`);
    assert.ok(['stopped', 'already_finished'].includes(second), `unexpected: ${second}`);
  });

  test(`${label}: cancellation matches the declared capability, honestly`, async () => {
    const engine = harness.create();
    const handle = await engine.createRun(SAMPLE_REQUEST, new AbortController().signal);

    if (capabilities.supportsOutOfBandStop) {
      // A different process really can stop it: cancelRun must take effect
      // without anyone holding the stream.
      const result = await engine.cancelRun(handle);
      assert.ok(['stopped', 'already_finished'].includes(result));
    } else {
      // No out-of-band stop. The requirement is
      // NOT that cancelRun works; it is that the adapter does not LIE about
      // having stopped something it cannot reach, and that aborting the owning
      // signal does terminate the stream.
      const controller = new AbortController();
      const seen: EngineEvent[] = [];
      for await (const event of engine.streamRun(handle, controller.signal)) {
        seen.push(event);
        if (seen.length === 1) controller.abort();
      }
      assert.ok(seen.length <= 2, `owner abort did not stop the stream: ${seen.length} events`);
    }
  });

  test(`${label}: cancelRun on an unknown id reports it, never throws`, async () => {
    const engine = harness.create();
    const result = await engine.cancelRun({
      operationId: 'op-does-not-exist',
      engineRunId: 'run-does-not-exist',
    });
    assert.equal(result, 'unknown_run');
  });

  test(`${label}: an owner abort does not wait out the run deadline`, async (t) => {
    if (!harness.scriptUnabortableSilence) {
      t.skip('harness does not script an unabortable silent vendor');
      return;
    }
    // The case the other cancellation tests miss: they abort after receiving a
    // frame, against a transport that honours abort by cancelling the body. A
    // vendor that accepts the connection, sends nothing, and ignores abort
    // leaves the read pending — so cancellation can only take effect when the
    // deadline fires. Measured at 401ms for an abort issued at 20ms against a
    // 400ms deadline, on an adapter that passed every other cancellation test.
    const engine = harness.create();
    harness.scriptUnabortableSilence(engine);

    const deadlineMs = 4_000;
    const request: EngineRunRequest = {
      ...SAMPLE_REQUEST,
      limits: { ...SAMPLE_REQUEST.limits, maxStreamDurationMs: deadlineMs },
    };
    const controller = new AbortController();
    const handle = await engine.createRun(request, controller.signal);

    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const events = await collect(engine.streamRun(handle, controller.signal));
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < deadlineMs / 2,
      `owner abort took ${elapsed}ms against a ${deadlineMs}ms deadline — it waited for the deadline`,
    );
    assert.ok(
      !events.some((event) => event.type === 'error' && event.category === 'timeout'),
      'an owner abort was reported as a deadline timeout',
    );
  });

  test(`${label}: aborting the signal terminates the stream promptly`, async () => {
    const engine = harness.create();
    const controller = new AbortController();
    const handle = await engine.createRun(SAMPLE_REQUEST, controller.signal);
    const received: EngineEvent[] = [];
    for await (const event of engine.streamRun(handle, controller.signal)) {
      received.push(event);
      if (received.length === 1) controller.abort();
    }
    assert.ok(received.length <= 2, `stream kept going after abort: ${received.length} events`);
  });

  for (const kind of ['http_500', 'socket_reset', 'malformed_frame'] as const) {
    test(`${label}: a vendor ${kind} surfaces as a normalized error event`, async () => {
      const engine = harness.create();
      harness.scriptVendorFailure(engine, kind);
      const handle = await engine.createRun(SAMPLE_REQUEST, new AbortController().signal);
      const events = await collect(engine.streamRun(handle, new AbortController().signal));
      const error = events.find((event) => event.type === 'error');
      assert.ok(error, 'expected a normalized error event, got none');
      assertEventMatchesSchema(error);
    });
  }

  test(`${label}: exceeding the duration limit fails the run as timeout`, async () => {
    const engine = harness.create();
    harness.scriptTimeout(engine);
    const handle = await engine.createRun(SAMPLE_REQUEST, new AbortController().signal);
    const events = await collect(engine.streamRun(handle, new AbortController().signal));
    const error = events.find((event) => event.type === 'error');
    assert.ok(error && error.type === 'error');
    assert.equal(error.category, 'timeout');
  });

  test(`${label}: exceeding maxOutputTokens ends the stream`, async () => {
    const engine = harness.create();
    harness.scriptOverlongOutput(engine);
    const handle = await engine.createRun(SAMPLE_REQUEST, new AbortController().signal);
    const events = await collect(engine.streamRun(handle, new AbortController().signal));
    const tokenCount = events.filter((event) => event.type === 'token').length;
    assert.ok(
      tokenCount <= SAMPLE_REQUEST.limits.maxOutputTokens,
      `emitted ${tokenCount} tokens against a limit of ${SAMPLE_REQUEST.limits.maxOutputTokens}`,
    );
    assert.ok(events.at(-1), 'stream ended with no events at all');
  });

  test(`${label}: every event matches the schema exactly`, async () => {
    const engine = harness.create();
    const handle = await engine.createRun(SAMPLE_REQUEST, new AbortController().signal);
    const events = await collect(engine.streamRun(handle, new AbortController().signal));
    assert.ok(events.length > 0, 'a successful run emitted no events');
    for (const event of events) assertEventMatchesSchema(event);
  });

  test(`${label}: health() leaks no credential, host, or path`, async () => {
    const engine = harness.create();
    const health = await engine.health();
    assert.ok(['live', 'degraded', 'disabled'].includes(health.status));
    const serialized = JSON.stringify(health);
    assert.ok(!/https?:\/\//i.test(serialized), 'health output contains a URL');
    assert.ok(!/\/(usr|etc|var|home|opt)\//.test(serialized), 'health output contains a path');
    assert.ok(
      !/(secret|token|key|password|bearer)/i.test(serialized),
      'health output looks credential-shaped',
    );
  });

  test(`${label}: attestKnowledgeCredential is stable, non-secret, and moves on rotation`, async () => {
    const engine = harness.create();
    const first = await engine.attestKnowledgeCredential();
    assert.equal(typeof first.credentialId, 'string');
    assert.ok(first.credentialId.length > 0);
    assert.equal(typeof first.spaceId, 'string');
    assert.ok(first.spaceId.length > 0);
    assert.equal(typeof first.rotationCounter, 'number');

    const again = await engine.attestKnowledgeCredential();
    assert.deepEqual(again, first, 'attestation must be stable between calls');

    const serialized = JSON.stringify(first);
    assert.ok(
      !/(secret|password|bearer|private)/i.test(serialized),
      'attestation looks like it carries secret material',
    );

    harness.rotateKnowledgeCredential(engine);
    const rotated = await engine.attestKnowledgeCredential();
    assert.notEqual(
      rotated.rotationCounter,
      first.rotationCounter,
      'rotation counter did not move — a silent credential swap would be undetectable',
    );
  });

  test(`${label}: declares findRunByOperationId iff it claims the capability`, () => {
    const engine = harness.create();
    assert.equal(
      typeof engine.findRunByOperationId === 'function',
      capabilities.supportsRunLookupByOperationId,
      'the capability flag and the method must agree, or startup checks are lying',
    );
  });
}
