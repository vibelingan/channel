import { configurationStateHash } from '../release/hosting-configuration.mjs';
import { verifyHostingObject } from '../release/hosting-readback.mjs';
import { identity } from '../release/input.mjs';

/** Resolve only an expired, interrupted A-to-A test upload. Never submit another file. */
export async function readbackDummyStatic({
  coordinator,
  provider,
  github,
  loadAccepted,
  policy,
  runId,
  clock = Date.now,
  requestHttp,
}) {
  if (!/^dummy-[1-9][0-9]*-static-restore$/.test(runId ?? ''))
    throw Error('Explicit interrupted static restore required');
  const status = await coordinator.status({ scopeKey: 'canary' });
  const run = await coordinator.runStatus(runId);
  const target = status.target;
  const step = status.pendingStep;
  const lease = target?.lease;
  const owner = new RegExp(
    `^github:${policy.repository}:([1-9][0-9]*):attempt-([1-9][0-9]*):drill$`,
  ).exec(lease?.runnerRef ?? '');
  if (
    !owner ||
    !lease ||
    clock() < lease.expiresAt ||
    target.currentRunId !== runId ||
    target.dirtyRunId !== runId ||
    run.state !== 'RUNNING' ||
    run.scopeKey !== 'canary' ||
    run.kind !== 'restore' ||
    !/^dummy-[1-9][0-9]*-static-A$/.test(run.restoredFromRunId ?? '') ||
    !step ||
    step.kind !== 'write' ||
    step.component !== 'static' ||
    step.state !== 'unknown' ||
    step.subject !== `upload:${policy.canaryPrefix}index.html` ||
    step.verifySubject !== `read:${policy.canaryPrefix}index.html` ||
    step.beforeHash !== step.afterHash ||
    run.verifiedWrites !== 0 ||
    run.verifiedSteps !== 0
  )
    throw Error('Only a known, expired A-to-A upload can be read back');
  const job = await github.api(`/actions/runs/${owner[1]}/attempts/${owner[2]}`);
  if (
    String(job.id) !== owner[1] ||
    String(job.run_attempt) !== owner[2] ||
    job.status !== 'completed' ||
    job.conclusion !== 'failure' ||
    job.event !== 'workflow_dispatch' ||
    job.path !== policy.workflowPath ||
    job.head_branch !== policy.trustedRef.slice(11) ||
    job.repository?.full_name !== policy.repository ||
    job.head_repository?.full_name !== policy.repository
  )
    throw Error('Interrupted writer has no authenticated terminal job proof');
  await github.requireCI(job.head_sha);
  const accepted = await coordinator.runStatus(run.restoredFromRunId);
  const input = await loadAccepted(accepted);
  const entry = input.staticManifest.entries[0];
  if (
    accepted.state !== 'SUCCEEDED' ||
    entry.path !== `${policy.canaryPrefix}index.html` ||
    entry.sha256 !== step.afterHash ||
    identity(run.composition.static) !== identity(accepted.composition.static) ||
    identity(provider.target) !== identity({ envId: policy.envId, site: policy.siteOrigin })
  )
    throw Error('Readback must match the exact archived and accepted A');
  const configuration = input.staticManifest.configuration;
  if (
    configurationStateHash(await provider.readConfiguration()) !==
    configurationStateHash(configuration)
  )
    throw Error('Configuration changed before readback');
  const owned = await provider.inventory(policy.canaryPrefix);
  if (owned.length !== 1 || owned[0] !== entry.path) throw Error('Canary inventory differs');
  await verifyHostingObject({ target: provider.target, entry, request: requestHttp });
  if (
    configurationStateHash(await provider.readConfiguration()) !==
    configurationStateHash(configuration)
  )
    throw Error('Configuration changed during readback');
  const result = await coordinator.reconcile({
    expectedVersion: target.version,
    expectedFence: lease.fence,
    proof: {
      runnerRef: lease.runnerRef,
      checkedAt: clock(),
      job: {
        status: 'completed',
        evidenceRef: `https://github.com/${policy.repository}/actions/runs/${owner[1]}/attempts/${owner[2]}`,
      },
      cloud: {
        status: 'quiescent',
        evidenceRef: `${policy.siteOrigin}/${policy.canaryPrefix} sha256:${entry.sha256}`,
        operationId: step.operationId,
        observedHash: entry.sha256,
      },
    },
  });
  if (result.recoveryRequired) throw Error('Reconciled outcome still requires a separate recovery');
  return {
    status: 'readback-confirmed',
    interruptedRunId: runId,
    writerRunId: owner[1],
    observedHash: entry.sha256,
    websiteWrites: 0,
  };
}
