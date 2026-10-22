import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setupFunctionExecution as setup } from './release-function-execution-fixture.mjs';
import { functionRecoveryContext } from './release/function-compatibility.mjs';
import { sha256 } from './release/input.mjs';

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
