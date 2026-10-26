import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
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
async function setup(pendingKind = 'accept', store = memoryStore()) {
  const time = clock();
  const client = createReleaseCoordinator({ store, policy, clock: time.now });
  let guard = await client.acquire(runner('owner-A'));
  await client.startRun({
    guard,
    runId: 'A',
    scopeKey: 'site',
    kind: 'adopt',
    composition: composition('A'),
    plan: plan(1),
  });
  let step = await client.beginStep({ guard, runId: 'A', ...stepInput('accept') });
  await client.confirmStep({ guard, runId: 'A', stepId: step.stepId, receipt: receipt(step) });
  await client.commitRun({ guard, runId: 'A', changeSetRef: 'A' });
  guard = await client.acquire(runner('owner-B'));
  await client.startRun({
    guard,
    runId: 'B',
    scopeKey: 'site',
    kind: 'publish',
    composition: composition('B'),
    deliveredComponents: ['static'],
    plan: plan(2),
  });
  step = await client.beginStep({ guard, runId: 'B', ...stepInput('write') });
  if (pendingKind === 'accept') {
    await client.confirmStep({ guard, runId: 'B', stepId: step.stepId, receipt: receipt(step) });
    step = await client.beginStep({ guard, runId: 'B', ...stepInput('accept') });
  }
  await client.markUnknown({ guard, runId: 'B', stepId: step.stepId, reason: 'Read interrupted' });
  time.advance(180001);
  const status = await client.status();
  const request = {
    runId: 'B',
    expectedVersion: status.target.version,
    expectedFence: guard.fence,
    ...runner('readback'),
    proof: {
      runnerRef: runner('owner-B').runnerRef,
      checkedAt: time.now(),
      job: { status: 'completed', evidenceRef: 'github:completed-owner-B' },
      cloud: { status: 'quiescent', kind: 'hosting-final-read-only' },
    },
  };
  return { store, time, client, guard, step, request };
}
test('a completed owner can hand over only the final read-only acceptance; no writes are repeated', async () => {
  const f = await setup();
  const guard = await f.client.resumeReadOnlyAcceptance(f.request);
  assert.equal(guard.fence, f.guard.fence + 1);
  await assert.rejects(
    f.client.confirmStep({
      guard: f.guard,
      runId: 'B',
      stepId: f.step.stepId,
      receipt: receipt(f.step),
    }),
    { code: 'LEASE_LOST' },
  );
  assert.equal((await f.client.runStatus('B')).verifiedWrites, 1);
  const next = await f.client.beginStep({
    guard,
    runId: 'B',
    ...stepInput('accept'),
    executionId: 'new-acceptance',
  });
  await f.client.confirmStep({ guard, runId: 'B', stepId: next.stepId, receipt: receipt(next) });
  await f.client.commitRun({ guard, runId: 'B', changeSetRef: 'verified-existing-B' });
  assert.equal((await f.client.status()).scope.baseline.sourceRunId, 'B');
  assert.equal((await f.client.status()).target.dirtyRunId, null);
});
test('pending cloud writes, active owners, stale fences and incomplete proofs cannot take over acceptance', async () => {
  const write = await setup('write');
  await assert.rejects(write.client.resumeReadOnlyAcceptance(write.request));
  const f = await setup();
  const before = f.store.commits;
  for (const change of [
    { runId: 'other' },
    { expectedVersion: 0 },
    { expectedFence: 0 },
    { proof: { ...f.request.proof, job: { status: 'in_progress', evidenceRef: 'running' } } },
    { proof: { ...f.request.proof, runnerRef: 'wrong' } },
    { proof: { ...f.request.proof, checkedAt: 0 } },
    { proof: { ...f.request.proof, cloud: { status: 'quiescent', kind: 'write' } } },
  ])
    await assert.rejects(f.client.resumeReadOnlyAcceptance({ ...f.request, ...change }));
  assert.equal(f.store.commits, before);
});
test('a readback worker that ends before confirmation can be replaced without accepting the candidate', async () => {
  const f = await setup();
  const first = await f.client.resumeReadOnlyAcceptance(f.request);
  f.time.advance(180001);
  const status = await f.client.status();
  const second = await f.client.resumeReadOnlyAcceptance({
    ...f.request,
    ...runner('readback-2'),
    expectedVersion: status.target.version,
    expectedFence: first.fence,
    proof: { ...f.request.proof, runnerRef: runner('readback').runnerRef, checkedAt: f.time.now() },
  });
  assert.equal(second.fence, first.fence + 1);
  assert.equal((await f.client.runStatus('B')).state, 'RUNNING');
  assert.equal((await f.client.runStatus('B')).verifiedSteps, 1);
});

test('final read-only takeover uses the installed SDK transaction and persists its fencing history', async (t) => {
  const sdk = cloudbaseFixture(t);
  const f = await setup('accept', sdk.store);
  const guard = await f.client.resumeReadOnlyAcceptance(f.request);
  const row = await f.client.runStatus('B');
  assert.equal(row.ownerRunId, guard.ownerRunId);
  assert.equal(row.writeFence, f.guard.fence);
  assert.equal(row.acceptanceResumptions.length, 1);
  assert.equal(row.verifiedSteps, 1);
  const next = await f.client.beginStep({ guard, runId: 'B', ...stepInput('accept') });
  await f.client.confirmStep({ guard, runId: 'B', stepId: next.stepId, receipt: receipt(next) });
  await f.client.commitRun({ guard, runId: 'B', changeSetRef: 'actual-sdk-readback' });
  assert.equal((await f.client.status()).scope.baseline.sourceRunId, 'B');
});
test('an owner whose lease is still active cannot be replaced even if its job ended', async () => {
  const f = await setup();
  f.time.advance(-10000);
  f.request.proof.checkedAt = f.time.now();
  await assert.rejects(f.client.resumeReadOnlyAcceptance(f.request), {
    code: 'READ_ONLY_ACCEPTANCE_REQUIRED',
  });
});
