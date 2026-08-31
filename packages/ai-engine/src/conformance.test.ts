/**
 * The fake is the conformance suite's first passing member. A suite that no
 * implementation passes proves nothing about the ones that come later.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type ConformanceHarness, runConformanceSuite } from './conformance.ts';
import { FakeEngine } from './fake-engine.ts';
import type { ConversationEngine } from './port.ts';

function asFake(engine: ConversationEngine): FakeEngine {
  if (!(engine instanceof FakeEngine)) throw new Error('harness received a foreign engine');
  return engine;
}

const harness: ConformanceHarness = {
  create: () => new FakeEngine(),
  scriptVendorFailure: (engine, kind) => asFake(engine).scriptFailure({ kind }),
  scriptTimeout: (engine) => asFake(engine).scriptFailure({ kind: 'timeout' }),
  scriptOverlongOutput: (engine) => asFake(engine).scriptFailure({ kind: 'overlong_output' }),
  rotateKnowledgeCredential: (engine) => asFake(engine).rotateKnowledgeCredential(),
  scriptCrashBetweenCallAndRecord: (engine) => asFake(engine).dropNextRecord(),
};

runConformanceSuite('fake-engine', harness);

/**
 * The suite above runs one configuration — the fully capable one. These cases
 * cover the degraded configurations, which is where the interesting behaviour
 * lives: a capability flag that disagrees with the object makes every startup
 * check downstream a lie.
 */

const DEGRADED_CAPS = { supportsRunLookupByOperationId: false } as const;

test('a fake declaring no lookup capability genuinely lacks the method', () => {
  const engine = new FakeEngine({ capabilities: DEGRADED_CAPS });
  assert.equal(engine.capabilities.supportsRunLookupByOperationId, false);
  assert.equal(
    typeof engine.findRunByOperationId,
    'undefined',
    'the flag says the capability is absent, so the method must be absent too',
  );
});

test('the fully capable fake exposes the lookup method and resolves a live handle', async () => {
  const engine = new FakeEngine();
  const handle = await engine.createRun(
    {
      operationId: 'op-lookup-1',
      conversationRef: 'conv-1',
      turns: [{ role: 'visitor', text: 'hello' }],
      profileId: 'public-cs@1',
      locale: 'en',
      limits: { maxDeliveredOutputUnits: 16, maxStreamDurationMs: 1_000, maxToolCalls: 0 },
    },
    new AbortController().signal,
  );
  assert.ok(engine.findRunByOperationId);
  assert.deepEqual(await engine.findRunByOperationId('op-lookup-1'), handle);
  assert.equal(await engine.findRunByOperationId('op-never-created'), null);
});

test('fresh fake-engine processes cannot mint the same durable engine run id', async () => {
  const request = (operationId: string) => ({
    operationId,
    conversationRef: 'conv-restart',
    turns: [{ role: 'visitor' as const, text: 'hello' }],
    profileId: 'public-cs@1',
    locale: 'en',
    limits: { maxDeliveredOutputUnits: 16, maxStreamDurationMs: 1_000, maxToolCalls: 0 },
  });
  const signal = new AbortController().signal;
  const one = await new FakeEngine().createRun(request('op-process-one'), signal);
  const two = await new FakeEngine().createRun(request('op-process-two'), signal);
  assert.notEqual(one.engineRunId, two.engineRunId);
});

test('the fake can select an unapproved citation for a process-level gate acceptance case', async () => {
  const engine = new FakeEngine({
    citations: [{ sourceId: 'channelkb-g1-public', title: 'Public' }],
    citationScenarios: [
      {
        whenMessageIncludes: 'gateway test document',
        citations: [{ sourceId: 'acceptance-unapproved-fixture', title: 'Fixture' }],
      },
    ],
  });
  const request = {
    operationId: 'op-publication-gate-fixture',
    conversationRef: 'conv-publication-gate-fixture',
    turns: [{ role: 'visitor' as const, text: 'What does the gateway test document say?' }],
    profileId: 'public-cs@1',
    locale: 'en',
    limits: { maxDeliveredOutputUnits: 16, maxStreamDurationMs: 1_000, maxToolCalls: 0 },
  };
  const signal = new AbortController().signal;
  const handle = await engine.createRun(request, signal);
  const events = [];
  for await (const event of engine.streamRun(handle, signal)) events.push(event);
  const final = events.find((event) => event.type === 'final');
  assert.equal(final?.type, 'final');
  assert.equal(final.citations[0]?.sourceId, 'acceptance-unapproved-fixture');
});

test('the degraded fake still passes the whole shared suite', () => {
  // Guards the swap promise: a vendor missing one optional capability must not
  // fail the contract, it must fail only the startup check that cares.
  runConformanceSuite('fake-engine (no operation-id lookup)', {
    ...harness,
    create: () => new FakeEngine({ capabilities: DEGRADED_CAPS }),
  });
});
