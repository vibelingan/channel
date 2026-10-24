import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clock,
  composition,
  memoryStore,
  plan,
  policy,
  receipt,
  runner,
  stepInput,
} from './release-state-fixtures.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

test('canary initialization accepts only its first static activation and leaves site untouched', async () => {
  const coordinator = createReleaseCoordinator({
    store: memoryStore(),
    policy,
    clock: clock().now,
  });
  const guard = await coordinator.acquire(runner('first-canary'));
  await coordinator.startRun({
    guard,
    runId: 'first',
    scopeKey: 'canary',
    kind: 'initialize',
    composition: composition('A'),
    deliveredComponents: ['static'],
    plan: plan(),
  });
  const write = await coordinator.beginStep({ guard, runId: 'first', ...stepInput() });
  await coordinator.recordSubmitted({
    guard,
    runId: 'first',
    stepId: write.stepId,
    receipt: receipt(write, 'submitted'),
  });
  await coordinator.confirmStep({
    guard,
    runId: 'first',
    stepId: write.stepId,
    receipt: receipt(write),
  });
  const accept = await coordinator.beginStep({ guard, runId: 'first', ...stepInput('accept') });
  await coordinator.confirmStep({
    guard,
    runId: 'first',
    stepId: accept.stepId,
    receipt: receipt(accept),
  });
  await coordinator.commitRun({ guard, runId: 'first', changeSetRef: 'canary-init' });
  assert.equal((await coordinator.status()).scope.active, null);
  assert.equal(
    (await coordinator.status({ scopeKey: 'canary' })).scope.active.sourceRunId,
    'first',
  );
  const next = await coordinator.acquire(runner('second'));
  await assert.rejects(
    coordinator.startRun({
      guard: next,
      runId: 'second',
      scopeKey: 'canary',
      kind: 'initialize',
      composition: composition('B'),
      deliveredComponents: ['static'],
      plan: plan(),
    }),
    /BASELINE_ALREADY_EXISTS/,
  );
});

test('initialize cannot waive the site baseline requirement', async () => {
  const coordinator = createReleaseCoordinator({
    store: memoryStore(),
    policy,
    clock: clock().now,
  });
  const guard = await coordinator.acquire(runner('site'));
  await assert.rejects(
    coordinator.startRun({
      guard,
      runId: 'site',
      scopeKey: 'site',
      kind: 'initialize',
      composition: composition('A'),
      deliveredComponents: ['static'],
      plan: plan(),
    }),
    /CANARY_INITIALIZATION_ONLY/,
  );
});
