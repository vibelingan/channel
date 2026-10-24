import { setTimeout as delay } from 'node:timers/promises';
import { checkFunctionArchive } from './function-archive.mjs';
import { functionRecoveryContext } from './function-compatibility.mjs';
import {
  assertFunctionRecoveryCurrent,
  assertFunctionRecoveryPlan,
  readFunctionRecoveryPackage,
} from './function-recovery.mjs';
import { freeze, identity } from './input.mjs';

export function functionCoordinatorPlan(plan) {
  return freeze({
    planSha256: plan.planSha256,
    acceptanceHash: identity(
      plan.functions.map((x) => ({
        name: x.baseline.name,
        sha256: x.baseline.sha256,
        codeSha: x.baseline.codeSha,
      })),
    ),
    stepCount: plan.functions.length + 1,
  });
}

/** D1 owns acquire/start/commit. This adapter records and verifies only explicitly planned function effects. */
export function createFunctionRecoveryAdapter({
  plan: input,
  directory,
  coordinator,
  guard: inputGuard,
  runId,
  provider: inputProvider,
  observe,
  probe,
  clock = Date.now,
  signal,
  heartbeatMs = 60_000,
  operationTimeoutMs = 300_000,
  pollIntervalMs = 1000,
}) {
  const plan = freeze(structuredClone(input));
  const guard = freeze(structuredClone(inputGuard));
  const provider = Object.freeze({ ...inputProvider });
  const descriptor = functionCoordinatorPlan(plan);
  if (
    identity(provider.target) !== identity(plan.target) ||
    typeof observe !== 'function' ||
    typeof probe !== 'function'
  )
    throw new Error('Function adapter target or observation mismatch');
  for (const [name, value, min, max] of [
    ['heartbeat', heartbeatMs, 10, 60_000],
    ['timeout', operationTimeoutMs, 20, 900_000],
    ['poll', pollIntervalMs, 1, 10_000],
  ])
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid function ${name}`);
  const completed = new Map();
  const configurationTokens = new Map();
  let accepted = false;
  let busy = false;
  let stopped = false;
  const enter = () => {
    if (busy) throw new Error('A function operation is already in progress');
    if (stopped) throw new Error('Function adapter requires manual readback');
    busy = true;
  };
  const item = (name) => {
    const value = plan.functions.find((x) => x.baseline.name === name);
    if (!value) throw new Error('Unplanned function');
    return value;
  };
  const receipt = (step, status, evidence = {}) => ({
    status,
    executionId: step.executionId,
    planSha256: step.planSha256,
    operationId: step.operationId,
    intentHash: step.intentHash,
    subject: status === 'submitted' ? step.subject : step.verifySubject,
    expectedHash: step.afterHash,
    observedHash: step.afterHash,
    terminal: status === 'verified',
    ...evidence,
  });
  async function ready(activeSignal) {
    activeSignal.throwIfAborted();
    assertFunctionRecoveryPlan(plan, clock());
    await coordinator.renew(guard);
    activeSignal.throwIfAborted();
    const [state, run] = await Promise.all([
      coordinator.status({ scopeKey: 'site' }),
      coordinator.runStatus(runId),
    ]);
    activeSignal.throwIfAborted();
    if (
      state.state !== 'leased' ||
      state.targetId !== guard.targetId ||
      state.target?.currentRunId !== runId ||
      state.target.target.envId !== plan.target.envId ||
      state.target.target.siteOrigin !== plan.target.siteOrigin ||
      run.state !== 'RUNNING' ||
      run.kind !== 'restore' ||
      run.scopeKey !== 'site' ||
      identity(run.plan) !== identity(descriptor) ||
      plan.functions.some(
        (x) =>
          !run.deliveredComponents.includes(`function:${x.baseline.name}`) ||
          identity(run.composition[`function:${x.baseline.name}`]) !==
            identity({
              releaseId: plan.sourceReleaseId,
              codeSha: x.baseline.codeSha,
              contentSha256: x.baseline.sha256,
              artifact: plan.sourceArtifact,
            }),
      )
    )
      throw new Error('Function plan differs from coordinated run');
  }
  async function unknown(step) {
    if (step)
      try {
        await coordinator.markUnknown({
          guard,
          runId,
          stepId: step.stepId,
          reason: 'Function outcome requires readback before another write',
        });
      } catch {
        /* The persisted intent/submission continues to block another writer. */
      }
  }
  async function leased(callback) {
    const controller = new AbortController();
    const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        await coordinator.renew(guard);
      } catch {
        controller.abort(new Error('Function lease lost'));
      } finally {
        renewing = false;
      }
    }, heartbeatMs);
    const timeout = setTimeout(
      () =>
        controller.abort(new Error('Function deadline reached; cloud work may still be running')),
      operationTimeoutMs,
    );
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(activeSignal.reason);
      activeSignal.addEventListener('abort', onAbort, { once: true });
      if (activeSignal.aborted) onAbort();
    });
    try {
      return await Promise.race([
        aborted,
        (async () => {
          await ready(activeSignal);
          const value = await callback(activeSignal);
          activeSignal.throwIfAborted();
          return value;
        })(),
      ]);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      activeSignal.removeEventListener('abort', onAbort);
    }
  }
  function checkSnapshot(snapshot, entry, hash) {
    if (
      snapshot.name !== entry.baseline.name ||
      snapshot.status !== 'Active' ||
      snapshot.availableStatus !== 'Available' ||
      snapshot.packageSha256 !== hash ||
      snapshot.runtime !== entry.baseline.runtime ||
      snapshot.handler !== entry.baseline.handler ||
      snapshot.role !== entry.baseline.role ||
      identity(snapshot.layers) !== identity(entry.baseline.layers)
    )
      throw new Error('Function code or retained configuration mismatch');
  }
  async function verify(entry, activeSignal) {
    const name = entry.baseline.name;
    const snapshot = await provider.read(name, { signal: activeSignal });
    activeSignal.throwIfAborted();
    checkSnapshot(snapshot, entry, entry.baseline.sha256);
    if (
      snapshot.configurationToken !== configurationTokens.get(name) ||
      snapshot.installDependency !== 'FALSE'
    )
      throw new Error('Function configuration changed during recovery');
    const health = await probe(name, entry.baseline.codeSha, { signal: activeSignal });
    activeSignal.throwIfAborted();
    if (
      health?.status !== 'healthy' ||
      health.name !== name ||
      health.codeSha !== entry.baseline.codeSha ||
      identity(health.target) !== identity(plan.target)
    )
      throw new Error('Unproven function health identity');
    const observation = await observe({ signal: activeSignal });
    activeSignal.throwIfAborted();
    const context = functionRecoveryContext({
      target: plan.target,
      baseline: entry.baseline,
      observation,
      now: clock(),
    });
    const expected = structuredClone(context.body);
    expected.current.codeSha = entry.currentCodeSha;
    expected.current.packageSha256 = entry.currentPackageSha256;
    if (
      context.body.current.codeSha !== entry.baseline.codeSha ||
      context.body.current.packageSha256 !== entry.baseline.sha256 ||
      identity(expected) !== entry.contextSha256
    )
      throw new Error('Data, client or configuration context changed during recovery');
    return {
      packageSha256: snapshot.packageSha256,
      codeSha: health.codeSha,
      requestId: snapshot.requestId,
    };
  }
  return Object.freeze({
    descriptor,
    async restore(name) {
      const entry = item(name);
      if (accepted) throw new Error('Function scope already accepted');
      enter();
      let step;
      try {
        return await leased(async (activeSignal) => {
          if (completed.has(name)) {
            await verify(entry, activeSignal);
            return completed.get(name);
          }
          const observation = await observe({ signal: activeSignal });
          activeSignal.throwIfAborted();
          assertFunctionRecoveryCurrent({ plan, observation, names: [name], now: clock() });
          const bytes = readFunctionRecoveryPackage({ plan, name, directory, now: clock() });
          checkFunctionArchive(bytes, { smoke: true });
          activeSignal.throwIfAborted();
          const before = await provider.read(name, { signal: activeSignal });
          activeSignal.throwIfAborted();
          checkSnapshot(before, entry, entry.currentPackageSha256);
          configurationTokens.set(name, before.configurationToken);
          await ready(activeSignal);
          step = await coordinator.beginStep({
            guard,
            runId,
            stepId: identity({ plan: plan.planSha256, name }),
            component: `function:${name}`,
            kind: 'write',
            beforeHash: before.packageSha256,
            afterHash: entry.baseline.sha256,
            subject: `code:${name}`,
            verifySubject: `ready:${name}`,
            executionId: `function:${plan.planSha256}:${name}`,
          });
          activeSignal.throwIfAborted();
          if (step.state === 'verified')
            throw new Error('Verified function intent requires explicit resumed readback');
          const submitted = await provider.updateCode(
            {
              name,
              runtime: entry.baseline.runtime,
              handler: entry.baseline.handler,
              bytes,
              sha256: entry.baseline.sha256,
              expectedSnapshot: before,
            },
            { signal: activeSignal },
          );
          activeSignal.throwIfAborted();
          if (submitted?.submitted !== true || !submitted.providerOperationId)
            throw new Error('Unconfirmed function submission');
          await coordinator.recordSubmitted({
            guard,
            runId,
            stepId: step.stepId,
            receipt: receipt(step, 'submitted', {
              providerOperationId: submitted.providerOperationId,
            }),
          });
          activeSignal.throwIfAborted();
          for (;;) {
            await ready(activeSignal);
            const snapshot = await provider.read(name, { signal: activeSignal });
            activeSignal.throwIfAborted();
            if (snapshot.status === 'Active' && snapshot.availableStatus === 'Available') break;
            if (
              ['CreateFailed', 'UpdateFailed', 'PublishFailed', 'DeleteFailed', 'Deleted'].includes(
                snapshot.status,
              ) ||
              snapshot.availableStatus !== 'Available'
            )
              throw new Error('Function lifecycle or billing failed');
            await delay(pollIntervalMs, undefined, { signal: activeSignal });
          }
          const evidence = await verify(entry, activeSignal);
          activeSignal.throwIfAborted();
          await coordinator.confirmStep({
            guard,
            runId,
            stepId: step.stepId,
            receipt: receipt(step, 'verified', { evidence }),
          });
          activeSignal.throwIfAborted();
          const result = freeze({
            status: 'verified',
            name,
            ...evidence,
            operationId: step.operationId,
          });
          completed.set(name, result);
          return result;
        });
      } catch (error) {
        if (step) stopped = true;
        await unknown(step);
        throw error;
      } finally {
        busy = false;
      }
    },
    async accept() {
      if (accepted) throw new Error('Function scope already accepted');
      enter();
      let step;
      try {
        return await leased(async (activeSignal) => {
          if (completed.size !== plan.functions.length)
            throw new Error('Functions remain unverified');
          for (const entry of plan.functions) await verify(entry, activeSignal);
          activeSignal.throwIfAborted();
          step = await coordinator.beginStep({
            guard,
            runId,
            stepId: identity({ plan: plan.planSha256, accept: true }),
            component: 'scope',
            kind: 'accept',
            beforeHash: descriptor.acceptanceHash,
            afterHash: descriptor.acceptanceHash,
            subject: 'accept',
            verifySubject: 'accept',
            executionId: `function:${plan.planSha256}:accept`,
          });
          activeSignal.throwIfAborted();
          await coordinator.confirmStep({
            guard,
            runId,
            stepId: step.stepId,
            receipt: receipt(step, 'verified'),
          });
          activeSignal.throwIfAborted();
          accepted = true;
          return { status: 'verified', acceptanceHash: descriptor.acceptanceHash };
        });
      } catch (error) {
        if (step) stopped = true;
        await unknown(step);
        throw error;
      } finally {
        busy = false;
      }
    },
  });
}
