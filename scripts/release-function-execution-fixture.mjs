import assert from 'node:assert/strict';
import { functionRecoveryFixture } from './release-function-fixtures.mjs';
import { functionManagerFixture, functionZip } from './release-function-manager-fixture.mjs';
import { memoryStore, receipt, runner, policy as storePolicy } from './release-state-fixtures.mjs';
import {
  createFunctionRecoveryAdapter,
  functionCoordinatorPlan,
} from './release/function-adapter.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { planFunctionRecovery } from './release/function-recovery.mjs';
import { sha256 } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

export async function setupFunctionExecution(t, { failure, options = {}, start = true } = {}) {
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
  const guard = start ? await client.acquire(runner('restore-worker')) : undefined;
  if (start)
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
  const adapter = start
    ? createFunctionRecoveryAdapter({
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
      })
    : null;
  return {
    x,
    store,
    client,
    plan,
    guard,
    sdk,
    provider,
    observe,
    probe,
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
