import { identity } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';
import { assertCleanAcceptedSite } from './site-policy.mjs';

const unproven = 'CATALOG_PREPARATION_RECOVERY_UNPROVEN';
const changed = 'CATALOG_PREPARATION_RECOVERY_CHANGED';
const fail = (code = unproven) => {
  throw Object.assign(Error(code), { code });
};
const terminal = new Set(['success', 'failure', 'cancelled', 'timed_out']);
const noHosting = (status) =>
  status?.state === 'stalled' &&
  status.target?.lease &&
  status.target.currentRunId === null &&
  status.target.dirtyRunId === null &&
  status.target.unresolvedOperation === null &&
  status.pendingStep === null &&
  status.scope?.scopeKey === 'site' &&
  status.scope.baseline?.sourceRunId;

async function absentFunction(functions, name) {
  const names = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const rows = await functions.listFunctions(100, offset);
    if (!Array.isArray(rows) || rows.length > 100) fail();
    for (const row of rows) {
      if (typeof row?.FunctionName !== 'string' || !row.FunctionName) fail();
      names.push(row.FunctionName);
    }
    if (rows.length < 100) {
      if (new Set(names).size !== names.length || names.includes(name)) fail();
      return;
    }
  }
  fail();
}

function checkReceipt(receipt, { policy, ownerRunId, functionName, codeSha }) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.purpose !== 'catalog-seo-regional-v1' ||
    receipt.runId !== ownerRunId ||
    receipt.codeSha !== codeSha ||
    receipt.functionName !== functionName ||
    receipt.environment !== policy.envId ||
    receipt.websiteWrites !== 0 ||
    receipt.businessWrites !== 0 ||
    receipt.created !== true ||
    receipt.cleaned !== true ||
    receipt.unconfirmed !== false ||
    !Array.isArray(receipt.calls) ||
    !receipt.calls.length ||
    receipt.calls.length > 50000 ||
    !receipt.calls.some(
      (call) =>
        call.action === 'health' && ['completed', 'readback-confirmed'].includes(call.state),
    )
  )
    fail();
  for (const call of receipt.calls)
    if (
      !call ||
      !['health', 'seed', 'prepare.step'].includes(call.action) ||
      !['completed', 'failed', 'readback-confirmed'].includes(call.state) ||
      typeof call.requestId !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,200}$/.test(call.requestId)
    )
      fail();
}

/** Release only a stopped preparation whose exact receipts prove that website delivery never began. */
export async function recoverCatalogPreparation({
  coordinator,
  github,
  policy,
  functions,
  readPreparationRun,
  loadEvidence,
  now = Date.now,
}) {
  let reconciling = false;
  try {
    const status = await coordinator.status({ scopeKey: 'site' });
    if (status.state !== 'stalled') return status;
    const targetId = normalizePolicy(policy).targetId;
    const lease = status.target?.lease;
    const match = /^site-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(lease?.ownerRunId ?? '');
    if (
      policy.repository !== 'vibelingan/channel' ||
      policy.workflowPath !== '.github/workflows/seo-static-canary.yml' ||
      !['refs/heads/feat/seo-foundation', 'refs/heads/test'].includes(policy.trustedRef) ||
      coordinator.targetId !== targetId ||
      status.targetId !== targetId ||
      !noHosting(status) ||
      !match ||
      !Number.isSafeInteger(now()) ||
      now() < lease.expiresAt ||
      lease.runnerRef !== `github:${policy.repository}:${match[1]}:attempt-${match[2]}` ||
      typeof readPreparationRun !== 'function' ||
      typeof loadEvidence !== 'function'
    )
      fail();
    const ownerRunId = lease.ownerRunId;
    // RUN_NOT_FOUND also covers malformed rows. Only an explicit raw null proves absence.
    if ((await readPreparationRun(ownerRunId)) !== null) fail();
    const run = await github.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
    if (
      String(run.id) !== match[1] ||
      String(run.run_attempt) !== match[2] ||
      !Number.isSafeInteger(run.repository?.id) ||
      run.repository.id < 1 ||
      run.repository.id !== run.head_repository?.id ||
      run.repository.full_name !== policy.repository ||
      run.head_repository.full_name !== policy.repository ||
      run.path !== policy.workflowPath ||
      run.head_branch !== policy.trustedRef.slice(11) ||
      run.event !== 'workflow_dispatch' ||
      run.status !== 'completed' ||
      !terminal.has(run.conclusion) ||
      !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')
    )
      fail();
    const jobs = [];
    let total;
    for (let page = 1; page <= 10; page++) {
      const response = await github.api(
        `/actions/runs/${match[1]}/attempts/${match[2]}/jobs?per_page=100&page=${page}`,
      );
      if (
        !Number.isSafeInteger(response.total_count) ||
        response.total_count < 1 ||
        response.total_count > 1000 ||
        !Array.isArray(response.jobs) ||
        response.jobs.length > 100 ||
        (total !== undefined && total !== response.total_count)
      )
        fail();
      total = response.total_count;
      jobs.push(...response.jobs);
      if (jobs.length === total) break;
      if (jobs.length > total || response.jobs.length !== 100) fail();
    }
    if (jobs.length !== total || new Set(jobs.map((job) => job.id)).size !== jobs.length) fail();
    const selected = jobs.filter((job) => job.name === 'site_delivery / site');
    const job = selected[0];
    if (
      selected.length !== 1 ||
      String(job.run_id) !== match[1] ||
      job.head_sha !== run.head_sha ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      job.status !== 'completed' ||
      !terminal.has(job.conclusion) ||
      !Number.isFinite(Date.parse(job.started_at)) ||
      !Number.isFinite(Date.parse(job.completed_at)) ||
      Date.parse(job.completed_at) < Date.parse(job.started_at)
    )
      fail();
    let stoppedAt = Date.parse(run.updated_at);
    if (!Number.isFinite(stoppedAt)) fail();
    for (const row of jobs) {
      const completedAt = Date.parse(row.completed_at);
      if (
        row.status !== 'completed' ||
        !Number.isFinite(completedAt) ||
        row.head_sha !== run.head_sha ||
        String(row.run_id) !== match[1]
      )
        fail();
      stoppedAt = Math.max(stoppedAt, completedAt);
    }
    if (now() - stoppedAt < 120000) fail();
    const functionName = `seo-catalog-region-${match[1]}-${match[2]}`;
    const artifactName = `site-delivery-evidence-${match[1]}-${match[2]}`;
    const evidence = await loadEvidence({
      run,
      job,
      ownerRunId,
      artifactName,
      regionalPath: 'regional/result.json',
    });
    checkReceipt(evidence, { policy, ownerRunId, functionName, codeSha: run.head_sha });
    await absentFunction(functions, functionName);
    if ((await readPreparationRun(ownerRunId)) !== null) fail();
    const current = await coordinator.status({ scopeKey: 'site' });
    if (
      !noHosting(current) ||
      current.target.version !== status.target.version ||
      identity(current.target.lease) !== identity(lease) ||
      identity(current.scope.baseline) !== identity(status.scope.baseline)
    )
      fail(changed);
    reconciling = true;
    await coordinator.reconcile({
      expectedVersion: status.target.version,
      expectedFence: lease.fence,
      proof: {
        runnerRef: lease.runnerRef,
        checkedAt: now(),
        job: {
          status: 'completed',
          evidenceRef: `github:${match[1]}:attempt-${match[2]}:job-${job.id}:${job.conclusion}:source-${run.head_sha}`,
        },
        cloud: {
          status: 'quiescent',
          kind: 'stopped-catalog-preparation-only',
          operationId: null,
          observedHash: null,
          evidenceRef: `${artifactName}:regional-cleaned:no-site-run:no-function:${functionName}`,
        },
      },
    });
    const released = await coordinator.status({ scopeKey: 'site' });
    if (identity(released.scope?.baseline) !== identity(status.scope.baseline)) fail(changed);
    assertCleanAcceptedSite(released);
    return released;
  } catch (error) {
    if ([unproven, changed].includes(error?.code)) throw error;
    fail(reconciling ? 'CATALOG_PREPARATION_RECOVERY_NEEDS_READBACK' : unproven);
  }
}
