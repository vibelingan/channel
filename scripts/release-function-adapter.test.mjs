import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { functionRecoveryFixture } from './release-function-fixtures.mjs';
import { functionManagerFixture, functionZip } from './release-function-manager-fixture.mjs';
import { memoryStore, receipt, runner, policy as storePolicy } from './release-state-fixtures.mjs';
import {
  createFunctionRecoveryAdapter,
  functionCoordinatorPlan,
} from './release/function-adapter.mjs';
import { functionRecoveryContext } from './release/function-compatibility.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { planFunctionRecovery } from './release/function-recovery.mjs';
import { sha256 } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

async function setup(t, { failure, options = {} } = {}) {
  const a = functionZip('exports.main = async () => "A";');
  const b = functionZip('exports.main = async () => "B";');
  const x = functionRecoveryFixture(t, { packageA: a, packageB: b });
  const store = memoryStore();
  const client = createReleaseCoordinator({ store, policy: storePolicy, clock: () => x.now });
  const component = (input) => ({
    releaseId: input.envelope.releaseId,
    codeSha: input.envelope.codeSha,
    contentSha256: input.envelope.functions[0].sha256,
    artifact: input.envelope.artifact,
  });
  for (const [name, input] of [
    ['baseline-A', x.baselineInput],
    ['baseline-B', x.compatibilityInput],
  ]) {
    const guard = await client.acquire(runner(name));
    const hash = input.envelope.functions[0].sha256;
    const descriptor = {
      planSha256: hash,
      acceptanceHash: hash,
      stepCount: name === 'baseline-A' ? 1 : 2,
    };
    await client.startRun({
      guard,
      runId: name,
      scopeKey: 'site',
      kind: name === 'baseline-A' ? 'adopt' : 'publish',
      composition:
        name === 'baseline-A'
          ? { static: component(input), 'function:public-api': component(input) }
          : { 'function:public-api': component(input) },
      ...(name === 'baseline-B' ? { deliveredComponents: ['function:public-api'] } : {}),
      plan: descriptor,
    });
    if (name === 'baseline-B') {
      const written = await client.beginStep({
        guard,
        runId: name,
        stepId: 'seed-write',
        component: 'function:public-api',
        kind: 'write',
        beforeHash: sha256(a),
        afterHash: sha256(b),
        subject: 'code:public-api',
        verifySubject: 'ready:public-api',
        executionId: 'seed-write',
      });
      await client.confirmStep({
        guard,
        runId: name,
        stepId: written.stepId,
        receipt: receipt(written),
      });
    }
    const step = await client.beginStep({
      guard,
      runId: name,
      stepId: 'seed-accept',
      component: 'scope',
      kind: 'accept',
      beforeHash: hash,
      afterHash: hash,
      subject: 'accept',
      verifySubject: 'accept',
      executionId: 'seed-accept',
    });
    await client.confirmStep({ guard, runId: name, stepId: step.stepId, receipt: receipt(step) });
    await client.commitRun({ guard, runId: name, changeSetRef: 'fixture:historical-adoption' });
  }
  x.acceptedRun = await client.runStatus('baseline-A');
  x.baselineInput.acceptedSeal = x.acceptedRun.accepted.seals['function:public-api'];
  const plan = planFunctionRecovery(x);
  const guard = await client.acquire(runner('restore-worker'));
  await client.startRun({
    guard,
    runId: 'restore-A',
    scopeKey: 'site',
    kind: 'restore',
    restoreFromRunId: 'baseline-A',
    deliveredComponents: ['function:public-api'],
    plan: functionCoordinatorPlan(plan),
  });
  const sdk = functionManagerFixture({ bytes: b });
  const provider = createCloudbaseFunctionProvider({
    ...sdk,
    target: x.target,
    region: 'ap-shanghai',
    names: ['public-api'],
  });
  sdk.state.fail = failure;
  sdk.state.onUpdate = () => {
    const rows = store.inspect();
    assert(
      rows.some(
        ([key, value]) =>
          key.startsWith('steps/') &&
          value.runId === 'restore-A' &&
          ['intent', 'submitted', 'unknown'].includes(value.state),
      ),
    );
  };
  let probes = 0;
  let observationChange;
  const observe = async () => {
    const observation = structuredClone(x.observation);
    if (sdk.state.bytes.equals(a)) {
      observation.functions[0].codeSha = 'a'.repeat(40);
      observation.functions[0].packageSha256 = sha256(a);
    }
    if (observationChange) observationChange(observation);
    return observation;
  };
  const probe = async (name, codeSha) => {
    probes++;
    if (failure === 'health')
      return { status: 'healthy', name, codeSha: 'c'.repeat(40), target: x.target };
    return { status: 'healthy', name, codeSha, target: x.target };
  };
  const adapter = createFunctionRecoveryAdapter({
    plan,
    directory: x.baselineInput.directory,
    coordinator: client,
    guard,
    runId: 'restore-A',
    provider,
    observe,
    probe,
    clock: () => x.now,
    pollIntervalMs: 1,
    ...options,
  });
  return {
    x,
    store,
    client,
    plan,
    guard,
    sdk,
    provider,
    adapter,
    a,
    b,
    get probes() {
      return probes;
    },
    changeObservation(fn) {
      observationChange = fn;
    },
  };
}

test('real SDK plus B1 journal restores archived A, checks health and retains the current static component', async (t) => {
  const f = await setup(t, { failure: 'updating' });
  const previous = await f.client.runStatus('baseline-B');
  const result = await f.adapter.restore('public-api');
  assert.equal(result.status, 'verified');
  assert.equal(f.sdk.state.updates, 1);
  assert.deepEqual(f.sdk.state.bytes, f.a);
  await assert.rejects(
    f.client.commitRun({ guard: f.guard, runId: 'restore-A', changeSetRef: 'too-early' }),
  );
  await f.adapter.restore('public-api');
  assert.equal(f.sdk.state.updates, 1);
  await f.adapter.accept();
  const committed = await f.client.commitRun({
    guard: f.guard,
    runId: 'restore-A',
    changeSetRef: 'verified:fixture',
  });
  assert.notEqual(committed.activation.activationId, f.x.acceptedRun.accepted.activationId);
  const run = await f.client.runStatus('restore-A');
  assert.equal(run.state, 'SUCCEEDED');
  assert.deepEqual(run.composition.static, previous.composition.static);
  assert.equal(run.composition['function:public-api'].contentSha256, sha256(f.a));
  assert.equal((await f.client.status()).state, 'idle');
});

for (const failure of [
  'lost-ack',
  'missing-receipt',
  'failed-state',
  'drift',
  'wrong-bytes',
  'health',
])
  test(`${failure} leaves the intent unresolved and cannot be accepted or retried`, async (t) => {
    const f = await setup(t, { failure });
    await assert.rejects(f.adapter.restore('public-api'));
    assert.equal(f.sdk.state.updates, 1);
    const status = await f.client.status();
    assert(status.pendingStep);
    assert.equal(status.pendingStep.state, 'unknown');
    await assert.rejects(f.adapter.restore('public-api'), /manual readback/);
    await assert.rejects(f.adapter.accept(), /manual readback/);
    assert.equal(f.sdk.state.updates, 1);
    await assert.rejects(
      f.client.commitRun({ guard: f.guard, runId: 'restore-A', changeSetRef: 'must-not-accept' }),
    );
  });

test('new data or client state invalidates the plan before a cloud write', async (t) => {
  const f = await setup(t);
  f.changeObservation((x) => {
    x.data.revision = 'new-data';
  });
  await assert.rejects(f.adapter.restore('public-api'));
  assert.equal(f.sdk.state.updates, 0);
  assert.equal((await f.client.status()).pendingStep, null);
});

test('accept refuses an unverified scope and an unplanned function cannot be restored', async (t) => {
  const f = await setup(t);
  await assert.rejects(f.adapter.accept(), /unverified/);
  await assert.rejects(f.adapter.restore('admin'), /Unplanned/);
  assert.equal(f.sdk.state.updates, 0);
});

test('another concurrent call does not start a second SDK update', async (t) => {
  const f = await setup(t);
  const first = f.adapter.restore('public-api');
  await assert.rejects(f.adapter.restore('public-api'), /in progress/);
  await first;
  assert.equal(f.sdk.state.updates, 1);
});

test('cancellation cannot revoke submitted SDK work; late completion cannot confirm or commit', async (t) => {
  const controller = new AbortController();
  const f = await setup(t, { options: { signal: controller.signal } });
  let enter;
  let release;
  let done;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const settled = new Promise((resolve) => {
    done = resolve;
  });
  f.sdk.state.holdUpdate = new Promise((resolve) => {
    release = resolve;
  });
  const original = f.sdk.state.onUpdate;
  f.sdk.state.onUpdate = () => {
    original();
    enter();
  };
  f.sdk.state.onUpdateSettled = () => done();
  const result = f.adapter.restore('public-api');
  await entered;
  controller.abort(new Error('controlled stop'));
  await assert.rejects(result);
  assert.equal((await f.client.status()).pendingStep?.state, 'unknown');
  release();
  await settled;
  await delay(0);
  assert.equal(f.sdk.state.updates, 1);
  assert.equal((await f.client.status()).pendingStep?.state, 'unknown');
  assert.equal(f.probes, 0);
  await assert.rejects(f.adapter.restore('public-api'), /manual readback/);
});

test('the compatibility context records layer order and the exact current ZIP hash', () => {
  const make = (layers, packageSha256) => ({
    target: { envId: 'fixture-env', siteOrigin: 'https://fixture.example' },
    baseline: {
      name: 'public-api',
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      role: 'fixture-role',
      layers: [],
      requiredConfigKeys: [],
      codeSha: 'a'.repeat(40),
      sha256: 'a'.repeat(64),
      packagePath: 'functions/a.zip',
    },
    observation: {
      target: { envId: 'fixture-env', siteOrigin: 'https://fixture.example' },
      observedAt: 10,
      data: { revision: 'd', formats: [], constraintsSha256: 'c'.repeat(64) },
      exposedClientContracts: [],
      functions: [
        {
          name: 'public-api',
          runtime: 'Nodejs20.19',
          handler: 'index.main',
          role: 'fixture-role',
          layers,
          status: 'Active',
          availableStatus: 'Available',
          codeSha: 'b'.repeat(40),
          packageSha256,
          configuration: { revision: 'r', references: [] },
        },
      ],
    },
    now: 10,
  });
  const layers = [
    { name: 'first', version: 1 },
    { name: 'second', version: 1 },
  ];
  const one = functionRecoveryContext(make(layers, 'b'.repeat(64))).sha256;
  assert.notEqual(one, functionRecoveryContext(make([...layers].reverse(), 'b'.repeat(64))).sha256);
  assert.notEqual(one, functionRecoveryContext(make(layers, 'd'.repeat(64))).sha256);
});
