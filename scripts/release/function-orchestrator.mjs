import { createFunctionRecoveryAdapter, functionCoordinatorPlan } from './function-adapter.mjs';
import { planFunctionRecovery } from './function-recovery.mjs';
import { freeze, identity } from './input.mjs';

/** Read-only plan; source loading and current observations must be authenticated adapters. */
export async function planManualFunctionRecovery({
  policy,
  coordinator,
  observer,
  loadAccepted,
  loadCompatibility,
  request: input,
  executorSha,
  token,
  guard,
  clock = Date.now,
}) {
  const request = freeze(structuredClone(input));
  if (
    !/^[a-f0-9]{40}$/.test(executorSha) ||
    !Array.isArray(request.names) ||
    !request.names.length ||
    new Set(request.names).size !== request.names.length ||
    request.names.some((x) => !policy.functions.includes(x)) ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(request.restoreRunId) ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(request.expectedActivationId) ||
    !/^[1-9][0-9]*$/.test(request.compatibilityArtifactId) ||
    typeof request.reason !== 'string' ||
    !request.reason.trim() ||
    request.reason.length > 512
  )
    throw new Error('Explicit function restore source, scope, activation and reason required');
  const status = await coordinator.status({ scopeKey: 'site' });
  if (
    status.pendingStep ||
    status.target?.currentRunId ||
    status.target?.dirtyRunId ||
    (guard
      ? status.state !== 'leased' ||
        status.target?.lease?.fence !== guard.fence ||
        status.target.lease.ownerRunId !== guard.ownerRunId
      : status.state !== 'idle') ||
    status.scope?.active?.activationId !== request.expectedActivationId
  )
    throw new Error('Site activation changed, absent, busy or unresolved');
  const source = await coordinator.runStatus(request.restoreRunId);
  const baselineInput = await loadAccepted(source, request.names);
  const compatibilityInput = await loadCompatibility(request.compatibilityArtifactId);
  const observation = await observer.observe();
  const plan = planFunctionRecovery({
    baselineInput,
    compatibilityInput,
    acceptedRun: source,
    policy: {
      ...baselineInput.policy,
      target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
      scope: { kind: 'site' },
    },
    observation,
    names: request.names,
    now: clock(),
  });
  const { planSha256, createdAt, expiresAt, ...stablePlan } = plan;
  const body = {
    executorSha,
    request,
    scopeVersion: status.scope.version,
    active: status.scope.active,
    plan: stablePlan,
  };
  const hash = identity(body);
  const reviewedAt = token ? Number(token.split(':')[1]) : clock();
  const reviewToken = `${hash}:${reviewedAt}`;
  if (
    !Number.isSafeInteger(reviewedAt) ||
    reviewedAt > clock() ||
    clock() - reviewedAt >= 300_000 ||
    (token !== undefined && token !== reviewToken)
  )
    throw new Error('Reviewed function plan changed or expired');
  return {
    plan,
    baselineInput,
    descriptor: functionCoordinatorPlan(plan),
    review: freeze({ sha256: hash, reviewedAt, token: reviewToken, ...body }),
  };
}

/** Manual D1 function-only recovery. Retained static/client versions remain subject to the compatibility proof. */
export async function executeManualFunctionRecovery(options) {
  const { coordinator, provider, observer, probe, runId, owner, adapterOptions = {} } = options;
  if (options.policy.enabled !== true || !options.token)
    throw new Error('Reviewed function execution is disabled or missing a token');
  const args = {
    ...options,
    policy: freeze(structuredClone(options.policy)),
    request: freeze(structuredClone(options.request)),
  };
  await planManualFunctionRecovery(args);
  const guard = await coordinator.acquire(owner);
  let started = false;
  try {
    const prepared = await planManualFunctionRecovery({ ...args, guard });
    await coordinator.startRun({
      guard,
      runId,
      scopeKey: 'site',
      kind: 'restore',
      restoreFromRunId: args.request.restoreRunId,
      deliveredComponents: prepared.plan.functions.map((x) => `function:${x.baseline.name}`),
      plan: prepared.descriptor,
    });
    started = true;
    const adapter = createFunctionRecoveryAdapter({
      ...adapterOptions,
      plan: prepared.plan,
      directory: prepared.baselineInput.directory,
      coordinator,
      guard,
      runId,
      provider,
      observe: observer.observe,
      probe,
      clock: args.clock,
    });
    const functions = [];
    for (const name of args.request.names) functions.push(await adapter.restore(name));
    await adapter.accept();
    await coordinator.renew(guard);
    const committed = await coordinator.commitRun({
      guard,
      runId,
      changeSetRef: `functions:${prepared.review.sha256}`,
    });
    return {
      ...committed,
      status: 'accepted',
      functions,
      static: 'retained',
      databaseRestore: 'not-run',
      searchNotifications: 0,
    };
  } catch (error) {
    try {
      const state = await coordinator.status({ scopeKey: 'site' });
      if (!state.pendingStep && !state.target?.unresolvedOperation) {
        if (started)
          await coordinator.failRun({
            guard,
            runId,
            reason: 'Function restore stopped; readback required before another write',
          });
        const after = await coordinator.status({ scopeKey: 'site' });
        if (!after.target?.dirtyRunId) await coordinator.release(guard);
      }
    } catch {
      /* Persisted intents and dirty state remain authoritative after lost acknowledgements. */
    }
    throw error;
  }
}
