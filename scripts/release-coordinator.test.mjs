import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clock,
  component,
  composition,
  hashA,
  memoryStore,
  plan,
  policy,
  receipt,
  runner,
  stepInput,
} from './release-state-fixtures.mjs';
import { hostingBatchBeforeHash, hostingRemovalHash } from './release/hosting-batches.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

const setup = () => {
  const store = memoryStore();
  const time = clock();
  return { store, time, client: createReleaseCoordinator({ store, policy, clock: time.now }) };
};

test('two independent coordinators cannot own the same environment', async () => {
  const f = setup();
  const other = createReleaseCoordinator({ store: f.store, policy, clock: f.time.now });
  await f.client.acquire(runner('r1'));
  await assert.rejects(other.acquire(runner('r2')), { code: 'LEASE_BUSY' });
});

test('a status read cannot initialize or mutate the control plane', async () => {
  const f = setup();
  const status = await f.client.status();
  assert.equal(status.state, 'uninitialized');
  assert.equal(f.store.commits, 0);
});

test('site and canary share the environment lease even across coordinator instances', async () => {
  const f = setup();
  await f.client.acquire(runner('r1'));
  await assert.rejects(
    f.client.acquire({ ...runner('r2'), scopeKey: 'canary', ref: 'other-branch' }),
    { code: 'LEASE_BUSY' },
  );
});

test('expired lease remains stalled and caller-supplied time cannot renew or steal it', async () => {
  const f = setup();
  const guard = await f.client.acquire(runner('r1'));
  f.time.advance(180_000);
  await assert.rejects(f.client.acquire({ ...runner('r2'), now: 0 }), { code: 'LEASE_STALLED' });
  await assert.rejects(f.client.renew({ ...guard, now: 0 }), { code: 'LEASE_LOST' });
  assert.equal((await f.client.status()).state, 'stalled');
});

test('heartbeat keeps ownership while a released lease advances the fence', async () => {
  const f = setup();
  const guard = await f.client.acquire(runner('r1'));
  assert.deepEqual(await f.client.acquire(runner('r1')), guard);
  f.time.advance(120_000);
  await f.client.renew(guard);
  f.time.advance(120_000);
  await f.client.release(guard);
  const next = await f.client.acquire(runner('r2'));
  assert.equal(next.fence, guard.fence + 1);
  await assert.rejects(f.client.renew(guard), { code: 'LEASE_LOST' });
});

test('adoption creates a run and freezes its plan without claiming the scope is active', async () => {
  const f = setup();
  const guard = await f.client.acquire(runner('r1'));
  const result = await f.client.startRun({
    guard,
    runId: 'adopt-A',
    scopeKey: 'site',
    kind: 'adopt',
    composition: composition('A'),
    plan: plan(1),
  });
  assert.equal(result?.state, 'RUNNING');
  assert.equal(result?.runId, 'adopt-A');
  assert.equal((await f.client.status()).scope.active, null);
  assert.equal((await f.client.status()).target.currentRunId, 'adopt-A');
});

test('publishing cannot begin without a previously accepted baseline', async () => {
  const f = setup();
  const guard = await f.client.acquire(runner('r1'));
  await assert.rejects(
    f.client.startRun({
      guard,
      runId: 'pub-B',
      scopeKey: 'site',
      kind: 'publish',
      composition: composition('B'),
      plan: plan(),
    }),
    { code: 'BASELINE_REQUIRED' },
  );
});

async function adoption(f, key = 'adopt-A', scopeKey = 'site', parts = composition('A')) {
  const guard = await f.client.acquire(runner(`owner-${key}`));
  await f.client.startRun({
    guard,
    runId: key,
    scopeKey,
    kind: 'adopt',
    composition: parts,
    plan: plan(1),
  });
  return { guard, runId: key };
}
async function accepted(f, key = 'adopt-A', scopeKey = 'site', parts = composition('A')) {
  const run = await adoption(f, key, scopeKey, parts);
  const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
  await f.client.confirmStep({ ...run, stepId: step.stepId, receipt: receipt(step) });
  const result = await f.client.commitRun({ ...run, changeSetRef: `changes:${key}` });
  return { ...run, result };
}

test('begin persists a pending intent before an external adapter could run', async () => {
  const f = setup();
  const run = await adoption(f);
  const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
  const status = await f.client.status();
  assert.equal(step?.state, 'intent');
  assert.equal(status.target.unresolvedOperation?.operationId, step.operationId);
  assert.equal(f.store.inspect().filter(([key]) => key.startsWith('steps/')).length, 1);
});

test('adopting a baseline never permits an external write step', async () => {
  const f = setup();
  const run = await adoption(f);
  await assert.rejects(f.client.beginStep({ ...run, ...stepInput() }), {
    code: 'INVALID_STEP_ORDER',
  });
});

test('pending intent blocks the next operation and lease release', async () => {
  const f = setup();
  const run = await adoption(f);
  await f.client.beginStep({ ...run, ...stepInput('accept') });
  await assert.rejects(f.client.beginStep({ ...run, ...stepInput('accept') }), {
    code: 'UNRESOLVED_OPERATION',
  });
  await assert.rejects(f.client.release(run.guard), { code: 'UNRESOLVED_OPERATION' });
});

test('verified acceptance atomically advances active, baseline and component seals', async () => {
  const f = setup();
  const { result } = await accepted(f);
  const status = await f.client.status();
  assert.equal(result?.status, 'committed');
  assert.equal(result?.isCurrent, true);
  assert.equal(status.scope.active?.activationId, result.activation.activationId);
  assert.equal(status.scope.baseline?.sourceRunId, 'adopt-A');
  assert.equal(status.state, 'idle');
  assert.equal(result.activation.seals.static.artifact.artifactId, '10');
});

for (const [label, change] of [
  ['false', () => false],
  ['void', () => undefined],
  ['pending', (s) => receipt(s, 'pending')],
  ['unbound operation', (s) => receipt(s, 'verified', { operationId: 'other' })],
  ['wrong hash', (s) => receipt(s, 'verified', { observedHash: hashA })],
  ['nonterminal cloud call', (s) => receipt(s, 'verified', { terminal: false })],
  ['old execution', (s) => receipt(s, 'verified', { executionId: 'old' })],
]) {
  test(`${label} cannot confirm a step or clear its unresolved record`, async () => {
    const f = setup();
    const run = await adoption(f);
    const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
    await assert.rejects(
      f.client.confirmStep({ ...run, stepId: step.stepId, receipt: change(step) }),
      { code: 'INVALID_RECEIPT' },
    );
    assert.equal(
      (await f.client.status()).target.unresolvedOperation?.operationId,
      step.operationId,
    );
  });
}

test('scope cannot commit before its planned acceptance has been verified', async () => {
  const f = setup();
  const run = await adoption(f);
  await assert.rejects(f.client.commitRun({ ...run, changeSetRef: 'changes:early' }), {
    code: 'ACCEPTANCE_REQUIRED',
  });
  assert.equal((await f.client.status()).scope.active, null);
});

async function publish(
  f,
  key = 'publish-B',
  parts = composition('B'),
  deliveredComponents = ['static'],
) {
  const guard = await f.client.acquire(runner(`owner-${key}`));
  await f.client.startRun({
    guard,
    runId: key,
    scopeKey: 'site',
    kind: 'publish',
    composition: parts,
    deliveredComponents,
    plan: plan(),
  });
  return { guard, runId: key };
}
async function verifyAll(f, run) {
  const write = await f.client.beginStep({ ...run, ...stepInput() });
  await f.client.recordSubmitted({
    ...run,
    stepId: write.stepId,
    receipt: receipt(write, 'submitted'),
  });
  await f.client.confirmStep({ ...run, stepId: write.stepId, receipt: receipt(write) });
  const acceptance = await f.client.beginStep({ ...run, ...stepInput('accept') });
  await f.client.confirmStep({ ...run, stepId: acceptance.stepId, receipt: receipt(acceptance) });
}
test('coordinator binds removal paths and before states to the signed intent', async () => {
  const f = setup();
  await accepted(f);
  const run = await publish(f);
  const removals = [{ path: 'products/p-retired/index.html', beforeHash: hashA }];
  const hash = hostingRemovalHash(removals.map((row) => row.path));
  const input = {
    ...run,
    ...stepInput(),
    beforeHash: hostingBatchBeforeHash(removals),
    afterHash: hash,
    subject: `remove-batch:${hash}`,
    verifySubject: `remove-batch:${hash}`,
    removals,
  };
  await assert.rejects(f.client.beginStep({ ...input, beforeHash: hashA }), {
    code: 'INVALID_BATCH_INTENT',
  });
  await assert.rejects(
    f.client.beginStep({ ...input, removals: [{ ...removals[0], path: 'other.html' }] }),
    { code: 'INVALID_BATCH_INTENT' },
  );
  const step = await f.client.beginStep(input);
  assert.deepEqual(step.removals, removals);
  const saved = f.store
    .inspect()
    .find(([key, row]) => key.startsWith('steps/') && row.operationId === step.operationId);
  assert(saved);
  saved[1].removals[0].path = 'other.html';
  f.store.replace('steps', saved[0].split('/')[1], saved[1]);
  await assert.rejects(f.client.status(), { code: 'CORRUPT_STEP' });
});
const proof = (status, time, step) => ({
  runnerRef: status.target.lease.runnerRef,
  checkedAt: time.now(),
  job: { status: 'completed', evidenceRef: 'github-job:terminal' },
  cloud: {
    status: 'quiescent',
    evidenceRef: 'cloud:readback',
    operationId: step?.operationId ?? null,
    observedHash: step?.beforeHash ?? null,
  },
});

test('an expired pending operation requires terminal-job and quiescent-cloud proof before takeover', async () => {
  const f = setup();
  await accepted(f);
  const run = await publish(f);
  const step = await f.client.beginStep({ ...run, ...stepInput() });
  f.time.advance(180_000);
  const status = await f.client.status();
  await assert.rejects(f.client.acquire(runner('new-owner')), { code: 'LEASE_STALLED' });
  await f.client.reconcile({
    expectedVersion: status.target.version,
    expectedFence: run.guard.fence,
    proof: proof(status, f.time, step),
  });
  assert.equal((await f.client.status()).target.unresolvedOperation, null);
  const next = await f.client.acquire(runner('new-owner'));
  assert.ok(next.fence > run.guard.fence);
  await assert.rejects(
    f.client.confirmStep({ ...run, stepId: step.stepId, receipt: receipt(step) }),
    { code: 'LEASE_LOST' },
  );
});

for (const [name, mutate] of [
  [
    'running job',
    (p) => {
      p.job.status = 'in_progress';
    },
  ],
  [
    'unknown cloud operation',
    (p) => {
      p.cloud.status = 'unknown';
    },
  ],
  [
    'wrong runner',
    (p) => {
      p.runnerRef = 'other';
    },
  ],
  [
    'wrong operation',
    (p) => {
      p.cloud.operationId = 'other';
    },
  ],
  [
    'stale evidence',
    (p) => {
      p.checkedAt -= 60_001;
    },
  ],
]) {
  test(`reconciliation rejects ${name} and retains the pending operation`, async () => {
    const f = setup();
    const run = await adoption(f);
    const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
    f.time.advance(180_000);
    const status = await f.client.status();
    const evidence = proof(status, f.time, step);
    mutate(evidence);
    await assert.rejects(
      f.client.reconcile({
        expectedVersion: status.target.version,
        expectedFence: run.guard.fence,
        proof: evidence,
      }),
      { code: 'INVALID_RECONCILIATION' },
    );
    assert.equal(
      (await f.client.status()).target.unresolvedOperation.operationId,
      step.operationId,
    );
  });
}

test('unknown writes stay pending; observed partial changes require recovery rather than a fresh publish', async () => {
  const f = setup();
  await accepted(f);
  const run = await publish(f);
  const step = await f.client.beginStep({ ...run, ...stepInput() });
  await f.client.markUnknown({ ...run, stepId: step.stepId, reason: 'network response lost' });
  await assert.rejects(f.client.failRun({ ...run, reason: 'cannot erase unknown call' }), {
    code: 'UNRESOLVED_OPERATION',
  });
  f.time.advance(180_000);
  const status = await f.client.status();
  const evidence = proof(status, f.time, step);
  evidence.cloud.observedHash = 'c'.repeat(64);
  await f.client.reconcile({
    expectedVersion: status.target.version,
    expectedFence: run.guard.fence,
    proof: evidence,
  });
  const guard = await f.client.acquire(runner('repair'));
  await assert.rejects(
    f.client.startRun({
      guard,
      runId: 'unsafe-new-publish',
      scopeKey: 'site',
      kind: 'publish',
      composition: composition('B'),
      deliveredComponents: ['static'],
      plan: plan(),
    }),
    { code: 'RECOVERY_REQUIRED' },
  );
});

test('same pending intent cannot grant a second permission to call the cloud', async () => {
  const f = setup();
  const run = await adoption(f);
  const input = { ...run, ...stepInput('accept') };
  await f.client.beginStep(input);
  await assert.rejects(f.client.beginStep(input), { code: 'STEP_REQUIRES_READBACK' });
});

test('restore A creates a new activation and makes A the baseline while preserving the failed run', async () => {
  const f = setup();
  const first = await accepted(f);
  const run = await publish(f);
  const write = await f.client.beginStep({ ...run, ...stepInput() });
  await f.client.confirmStep({ ...run, stepId: write.stepId, receipt: receipt(write) });
  await f.client.failRun({ ...run, reason: 'ordinary URL acceptance failed' });
  await f.client.startRun({
    guard: run.guard,
    runId: 'restore-A',
    scopeKey: 'site',
    kind: 'restore',
    restoreFromRunId: 'adopt-A',
    deliveredComponents: ['static'],
    plan: plan(),
  });
  const restore = { guard: run.guard, runId: 'restore-A' };
  await verifyAll(f, restore);
  const result = await f.client.commitRun({ ...restore, changeSetRef: 'changes:restore-A' });
  assert.notEqual(result.activation.activationId, first.result.activation.activationId);
  assert.equal(result.activation.seals.static.releaseId, 'release-A');
  assert.equal((await f.client.status()).scope.baseline.sourceRunId, 'restore-A');
  assert.equal((await f.client.runStatus(run.runId)).state, 'FAILED_RECOVERED');
  assert.equal((await f.client.runStatus(run.runId)).reason, 'ordinary URL acceptance failed');
});

test('static-only delivery retains existing function provenance and ignores unshipped candidate functions', async () => {
  const f = setup();
  await accepted(f, 'adopt-A', 'site', { ...composition('A'), 'function:api': component('A') });
  const run = await publish(f, 'publish-B', {
    ...composition('B'),
    'function:api': component('B'),
  });
  await verifyAll(f, run);
  const result = await f.client.commitRun({ ...run, changeSetRef: 'changes:B' });
  assert.equal(result.activation.seals.static.releaseId, 'release-B');
  assert.equal(result.activation.seals['function:api'].releaseId, 'release-A');
});

test('lost commit acknowledgement and late replay cannot publish twice or overwrite a newer activation', async () => {
  const f = setup();
  const run = await adoption(f);
  const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
  await f.client.confirmStep({ ...run, stepId: step.stepId, receipt: receipt(step) });
  f.store.loseNextAck();
  await assert.rejects(
    f.client.commitRun({ ...run, changeSetRef: 'changes:A' }),
    /Commit response lost/,
  );
  const replay = await f.client.commitRun({ ...run, changeSetRef: 'changes:A' });
  assert.equal(replay.status, 'already-committed');
  const newer = await publish(f);
  await verifyAll(f, newer);
  await f.client.commitRun({ ...newer, changeSetRef: 'changes:B' });
  const old = await f.client.commitRun({ ...run, changeSetRef: 'changes:A' });
  assert.equal(old.isCurrent, false);
  assert.equal((await f.client.status()).scope.active.sourceRunId, newer.runId);
});

test('a caller mutating its request during the transaction cannot change the confirmed result', async () => {
  const f = setup();
  const run = await adoption(f);
  const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
  const input = { ...run, stepId: step.stepId, receipt: receipt(step) };
  const pending = f.client.confirmStep(input);
  input.receipt = false;
  await pending;
  assert.equal((await f.client.status()).target.unresolvedOperation, null);
});

test('a damaged intent cannot be repaired by matching a receipt to its damaged after-hash', async () => {
  const f = setup();
  const run = await adoption(f);
  const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
  const [key, row] = f.store.inspect().find(([key]) => key.startsWith('steps/'));
  row.afterHash = hashA;
  f.store.replace('steps', key.slice(6), row);
  await assert.rejects(
    f.client.confirmStep({ ...run, stepId: step.stepId, receipt: receipt(row) }),
    { code: 'CORRUPT_STEP' },
  );
});

test('baseline adoption cannot be used a second time to bypass normal delivery', async () => {
  const f = setup();
  await accepted(f);
  const guard = await f.client.acquire(runner('bypass'));
  await assert.rejects(
    f.client.startRun({
      guard,
      runId: 'adopt-B',
      scopeKey: 'site',
      kind: 'adopt',
      composition: composition('B'),
      plan: plan(1),
    }),
    { code: 'BASELINE_ALREADY_EXISTS' },
  );
});

test('a failed build with no cloud intent does not require a restore', async () => {
  const f = setup();
  await accepted(f);
  const run = await publish(f);
  const result = await f.client.failRun({ ...run, reason: 'lint failed before upload' });
  assert.equal(result.recoveryRequired, false);
  await f.client.release(run.guard);
  const guard = await f.client.acquire(runner('wrong-auto-recovery'));
  await assert.rejects(
    f.client.startRun({
      guard,
      runId: 'unnecessary-restore',
      scopeKey: 'site',
      kind: 'restore',
      failedRunId: run.runId,
      deliveredComponents: ['static'],
      plan: plan(),
    }),
    { code: 'INVALID_FAILED_RUN' },
  );
});

test('a terminal not-applied result clears only a first unmodified write', async () => {
  const f = setup();
  await accepted(f);
  const run = await publish(f);
  const step = await f.client.beginStep({ ...run, ...stepInput() });
  const result = await f.client.failStep({
    ...run,
    stepId: step.stepId,
    reason: 'rejected before write',
    receipt: receipt(step, 'not-applied', {
      expectedHash: step.beforeHash,
      observedHash: step.beforeHash,
      terminal: true,
    }),
  });
  assert.equal(result.recoveryRequired, false);
  await f.client.release(run.guard);
});

test('heartbeat and duplicate confirmation cannot double-count a verified step', async () => {
  const f = setup();
  const run = await adoption(f);
  const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
  f.time.advance(60_000);
  await f.client.renew(run.guard);
  await f.client.confirmStep({ ...run, stepId: step.stepId, receipt: receipt(step) });
  await f.client.confirmStep({ ...run, stepId: step.stepId, receipt: receipt(step) });
  assert.equal((await f.client.runStatus(run.runId)).verifiedSteps, 1);
  await f.client.commitRun({ ...run, changeSetRef: 'changes:A' });
});

test('unselected static content is retained when only a function is delivered', async () => {
  const f = setup();
  await accepted(f, 'adopt-A', 'site', { ...composition('A'), 'function:api': component('A') });
  const run = await publish(f, 'function-B', { 'function:api': component('B') }, ['function:api']);
  const write = await f.client.beginStep({ ...run, ...stepInput(), component: 'function:api' });
  await f.client.confirmStep({ ...run, stepId: write.stepId, receipt: receipt(write) });
  const end = await f.client.beginStep({ ...run, ...stepInput('accept') });
  await f.client.confirmStep({ ...run, stepId: end.stepId, receipt: receipt(end) });
  const result = await f.client.commitRun({ ...run, changeSetRef: 'changes:function-B' });
  assert.equal(result.activation.seals.static.releaseId, 'release-A');
  assert.equal(result.activation.seals['function:api'].releaseId, 'release-B');
});

test('canary activation changes only its own scope baseline', async () => {
  const f = setup();
  const site = await accepted(f);
  await accepted(f, 'canary-A', 'canary');
  assert.equal(
    (await f.client.status()).scope.active.activationId,
    site.result.activation.activationId,
  );
  assert.equal(
    (await f.client.status({ scopeKey: 'canary' })).scope.active.sourceRunId,
    'canary-A',
  );
});

test('a changed trusted canary prefix cannot create a second lock for the same target', async () => {
  const f = setup();
  await f.client.acquire(runner('r1'));
  const other = createReleaseCoordinator({
    store: f.store,
    policy: { ...policy, canaryPrefix: 'other/' },
    clock: f.time.now,
  });
  assert.equal(other.targetId, f.client.targetId);
  await assert.rejects(other.acquire(runner('r2')), { code: 'TARGET_POLICY_MISMATCH' });
});

test('unknown schemas and overflowing counters are rejected without resetting the ledger', async () => {
  for (const change of [
    (row) => {
      row.schemaVersion = 2;
    },
    (row) => {
      row.nextFence = Number.MAX_SAFE_INTEGER;
      row.lease = null;
    },
  ]) {
    const f = setup();
    await f.client.acquire(runner('r1'));
    const [key, row] = f.store.inspect().find(([key]) => key.startsWith('targets/'));
    change(row);
    f.store.replace('targets', key.slice(8), row);
    const before = f.store.commits;
    await assert.rejects(f.client.acquire(runner('r2')));
    assert.equal(f.store.commits, before);
  }
});

test('retained function seals keep their original acceptance identity', async () => {
  const f = setup();
  const baseline = await accepted(f, 'adopt-A', 'site', {
    ...composition('A'),
    'function:api': component('A'),
  });
  const run = await publish(f);
  await verifyAll(f, run);
  const result = await f.client.commitRun({ ...run, changeSetRef: 'changes:B' });
  assert.equal(
    result.activation.seals['function:api'].activationId,
    baseline.result.activation.seals['function:api'].activationId,
  );
});

async function failedPublish(f) {
  await accepted(f);
  const run = await publish(f);
  const step = await f.client.beginStep({ ...run, ...stepInput() });
  await f.client.confirmStep({ ...run, stepId: step.stepId, receipt: receipt(step) });
  await f.client.failRun({ ...run, reason: 'failed publication acceptance' });
  return run;
}

test('a not-applied recovery write cannot clear damage left by the failed publication', async () => {
  const f = setup();
  const failed = await failedPublish(f);
  const run = { guard: failed.guard, runId: 'restore-A' };
  await f.client.startRun({
    ...run,
    kind: 'restore',
    scopeKey: 'site',
    deliveredComponents: ['static'],
    plan: plan(),
  });
  const step = await f.client.beginStep({ ...run, ...stepInput() });
  const result = await f.client.failStep({
    ...run,
    stepId: step.stepId,
    reason: 'recovery write rejected',
    receipt: receipt(step, 'not-applied', {
      expectedHash: step.beforeHash,
      observedHash: step.beforeHash,
      terminal: true,
    }),
  });
  assert.equal(result.recoveryRequired, true);
  assert.equal((await f.client.status()).target.dirtyRunId, failed.runId);
});

test('manual recovery after a failed recovery records the original failed publication as recovered', async () => {
  const f = setup();
  const failed = await failedPublish(f);
  const first = { guard: failed.guard, runId: 'restore-failed' };
  await f.client.startRun({
    ...first,
    kind: 'restore',
    scopeKey: 'site',
    deliveredComponents: ['static'],
    plan: plan(),
  });
  const write = await f.client.beginStep({ ...first, ...stepInput() });
  await f.client.confirmStep({ ...first, stepId: write.stepId, receipt: receipt(write) });
  await f.client.failRun({ ...first, reason: 'recovery acceptance failed' });
  const final = { guard: failed.guard, runId: 'restore-manual' };
  await f.client.startRun({
    ...final,
    kind: 'restore',
    scopeKey: 'site',
    deliveredComponents: ['static'],
    plan: plan(),
  });
  await verifyAll(f, final);
  await f.client.commitRun({ ...final, changeSetRef: 'changes:manual' });
  assert.equal((await f.client.runStatus(failed.runId)).state, 'FAILED_RECOVERED');
  assert.equal((await f.client.runStatus(first.runId)).state, 'FAILED_RECOVERED');
});

test('a historical commit receipt cannot be replayed through a foreign target guard', async () => {
  const f = setup();
  const run = await accepted(f);
  await assert.rejects(
    f.client.commitRun({
      guard: { ...run.guard, targetId: 'other-target' },
      runId: run.runId,
      changeSetRef: 'changes:adopt-A',
    }),
    { code: 'LEASE_LOST' },
  );
});

test('a stale scope version cannot commit a new activation', async () => {
  const f = setup();
  await accepted(f);
  const run = await publish(f);
  await verifyAll(f, run);
  const [key, scope] = f.store.inspect().find(([key]) => key.startsWith('scopes/'));
  scope.version++;
  f.store.replace('scopes', key.slice(7), scope);
  await assert.rejects(f.client.commitRun({ ...run, changeSetRef: 'changes:B' }), {
    code: 'STALE_ACTIVATION',
  });
});

test('a replacement runner can read the pending provider operation without renewing or mutating it', async () => {
  const f = setup();
  const run = await adoption(f);
  const step = await f.client.beginStep({ ...run, ...stepInput('accept') });
  await f.client.recordSubmitted({
    ...run,
    stepId: step.stepId,
    receipt: receipt(step, 'submitted', { providerOperationId: 'cloud-request-1' }),
  });
  f.time.advance(180_000);
  const before = f.store.commits;
  const other = createReleaseCoordinator({ store: f.store, policy, clock: f.time.now });
  const status = await other.status();
  assert.equal(status.pendingStep?.submittedReceipt?.providerOperationId, 'cloud-request-1');
  assert.equal(status.state, 'stalled');
  assert.equal(f.store.commits, before);
});
