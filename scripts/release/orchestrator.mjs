import { assertErrorDocument, assertMutableCachePolicy } from '../hosting-contract.mjs';
import {
  executeHostingRecovery,
  planReleaseCandidate,
  planReleaseRecovery,
} from '../hosting-recovery.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { canaryArtifact, reviewCanaryPlan, verifyPlanToken } from './canary.mjs';
import { createHostingRecoveryAdapters, hostingCoordinatorPlan } from './hosting-adapter.mjs';
import { configurationStateHash, prepareHostingConfiguration } from './hosting-configuration.mjs';
import { verifyHostingObject } from './hosting-readback.mjs';
import { freeze, identity } from './input.mjs';

function assertAccepted(run, input) {
  if (
    run?.state !== 'SUCCEEDED' ||
    run.scopeKey !== 'canary' ||
    run.accepted?.sourceRunId !== run.runId ||
    run.accepted.compositionHash !== identity(run.composition) ||
    identity(run.composition.static.artifact) !== identity(input.envelope.artifact) ||
    identity(run.accepted.seals.static) !== identity(input.acceptedSeal)
  )
    throw new Error('Untrusted accepted canary source');
  const plan = planReleaseRecovery({
    artifactInput: input,
    currentOwnedPaths: [],
    publicProductPaths: [],
  });
  if (run.composition.static.contentSha256 !== plan.stateSha256)
    throw new Error('Accepted canary content identity mismatch');
}

/** Read-only planning; its result is rederived under the lease immediately before execution. */
export async function planManualCanary({
  policy,
  coordinator,
  provider,
  input: source,
  request: suppliedRequest,
  loadAccepted,
  requestHttp = fetchFully,
  clock = Date.now,
  guard,
  token,
}) {
  const request = freeze(structuredClone(suppliedRequest));
  const input = canaryArtifact({
    directory: source.directory,
    policy,
    run: source.run,
    acceptedSeal: source.acceptedSeal,
    now: clock(),
  });
  const status = await coordinator.status({ scopeKey: 'canary' });
  if (
    status.pendingStep ||
    status.target?.currentRunId ||
    status.target?.dirtyRunId ||
    (guard
      ? status.state !== 'leased' ||
        status.target.lease.ownerRunId !== guard.ownerRunId ||
        status.target.lease.fence !== guard.fence
      : !['idle', 'uninitialized'].includes(status.state))
  )
    throw new Error('Target busy or unresolved; manual readback required');
  const review = token
    ? verifyPlanToken({ token, input, request, status, now: clock() })
    : reviewCanaryPlan({ input, request, status, now: clock() });
  const configurationPlan = prepareHostingConfiguration({
    target: provider.target,
    before: input.staticManifest.configuration,
  });
  const current = await provider.readConfiguration();
  if (configurationStateHash(current) !== configurationStateHash(configurationPlan.before))
    throw new Error('Hosting configuration drift; no global configuration writes permitted');
  if (identity(provider.target) !== identity({ envId: policy.envId, site: policy.siteOrigin }))
    throw new Error('Canary provider target mismatch');
  const owned = await provider.inventory(policy.canaryPrefix);
  const path = `${policy.canaryPrefix}index.html`;
  if (!Array.isArray(owned) || owned.some((p) => p !== path) || owned.length > 1)
    throw new Error('Canary prefix contains unowned files');
  if (request.action === 'initialize') {
    if (owned.length) throw new Error('Initial canary prefix is occupied');
    for (const revalidate of [false, true]) {
      const response = await requestHttp('GET', `${policy.siteOrigin}/${policy.canaryPrefix}`, {
        timeoutMs: 15_000,
        maxBytes: 131_072,
        redirect: 'error',
        headers: revalidate ? { 'cache-control': 'no-cache' } : {},
      });
      if (response.status !== 404) throw new Error('Initial canary prefix is not absent');
      assertMutableCachePolicy(response.headers.get('cache-control') ?? '');
      assertErrorDocument(response.body);
    }
  } else {
    if (owned.length !== 1) throw new Error('Accepted canary file missing');
    const baselineRun = await coordinator.runStatus(status.scope.baseline.sourceRunId);
    const baseline = await loadAccepted(baselineRun);
    assertAccepted(baselineRun, baseline);
    await verifyHostingObject({
      target: provider.target,
      entry: baseline.staticManifest.entries[0],
      request: requestHttp,
    });
    if (request.action === 'restore') {
      if (!request.restoreRunId) throw new Error('Explicit accepted restore run required');
      const run = await coordinator.runStatus(request.restoreRunId);
      assertAccepted(run, input);
    } else if (input.acceptedSeal) throw new Error('Use restore for an accepted artifact');
  }
  const plan =
    request.action === 'restore'
      ? planReleaseRecovery({
          artifactInput: input,
          currentOwnedPaths: owned,
          publicProductPaths: [],
        })
      : planReleaseCandidate({ artifactInput: input, currentOwnedPaths: owned });
  if (plan.uploads.length !== 1 || plan.deletes.length || configurationPlan.changes.length)
    throw new Error('D1 write scope escaped one static file');
  return {
    review,
    input,
    plan,
    configurationPlan,
    descriptor: hostingCoordinatorPlan(plan, configurationPlan),
  };
}

export async function executeManualCanary(options) {
  const {
    coordinator,
    provider,
    loadAccepted,
    requestHttp = fetchFully,
    clock = Date.now,
    runId,
    owner,
    adapterOptions = {},
  } = options;
  const policy = freeze(structuredClone(options.policy));
  if (policy.enabled !== true)
    throw new Error('Live canary execution disabled by committed policy');
  const args = {
    policy,
    coordinator,
    provider,
    loadAccepted,
    requestHttp,
    clock,
    input: options.input,
    request: freeze(structuredClone(options.request)),
    token: options.token,
  };
  if (!args.token) throw new Error('Reviewed plan token required');
  await planManualCanary(args);
  const guard = await coordinator.acquire(owner);
  let started = false;
  try {
    const prepared = await planManualCanary({ ...args, guard });
    await coordinator.renew(guard);
    const { input, plan, configurationPlan, descriptor } = prepared;
    await coordinator.startRun({
      guard,
      runId,
      scopeKey: 'canary',
      kind: args.request.action,
      ...(args.request.action === 'restore'
        ? { restoreFromRunId: args.request.restoreRunId }
        : {
            composition: {
              static: {
                releaseId: input.envelope.releaseId,
                codeSha: input.envelope.codeSha,
                contentSha256: plan.stateSha256,
                artifact: input.envelope.artifact,
              },
            },
          }),
      deliveredComponents: ['static'],
      plan: descriptor,
    });
    started = true;
    const adapters = createHostingRecoveryAdapters({
      ...adapterOptions,
      plan,
      directory: input.directory,
      configurationPlan,
      coordinator,
      guard,
      runId,
      provider,
      request: requestHttp,
    });
    const evidence = await executeHostingRecovery(plan, adapters);
    await coordinator.renew(guard);
    const committed = await coordinator.commitRun({
      guard,
      runId,
      changeSetRef: `canary:${prepared.review.sha256}`,
    });
    return {
      ...committed,
      status: 'accepted',
      evidence,
      review: prepared.review,
      functions: 'not-run',
      searchNotifications: 0,
    };
  } catch (error) {
    // Never turn an unknown SDK outcome into a clean retry or an automatic recovery.
    try {
      const state = await coordinator.status({ scopeKey: 'canary' });
      if (!state.pendingStep) {
        if (started)
          await coordinator.failRun({
            guard,
            runId,
            reason: 'Manual canary stopped; inspect evidence before further writes',
          });
        if (!state.target?.dirtyRunId) await coordinator.release(guard);
      }
    } catch {
      /* A lost lease or lost commit acknowledgement requires readback, not another write. */
    }
    throw error;
  }
}
