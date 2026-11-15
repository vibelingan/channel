import { setTimeout as pause } from 'node:timers/promises';
import { readCompleteFunctionInventory as functionInventory } from './function-inventory.mjs';
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
  status.target.unresolvedOperation === null &&
  status.pendingStep === null &&
  status.scope?.scopeKey === 'site' &&
  status.scope.baseline?.sourceRunId;

function checkInheritedDirty(status, row, policy, now) {
  const runId = status.target.dirtyRunId;
  if (runId === null) return null;
  const match = /^site-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(runId ?? '');
  const proof = row?.reconciliation;
  const part = row?.composition?.static;
  if (
    !match ||
    row?.schemaVersion !== 1 ||
    row.targetId !== status.targetId ||
    row.runId !== runId ||
    row.state !== 'FAILED' ||
    row.accepted !== null ||
    row.scopeKey !== 'site' ||
    !['publish', 'reconcile'].includes(row.kind) ||
    row.ownerRunId !== runId ||
    row.deliveredComponents?.join(',') !== 'static' ||
    Object.keys(row.composition ?? {}).join(',') !== 'static' ||
    !/^[a-f0-9]{40}$/.test(part?.codeSha ?? '') ||
    part?.artifact?.repository !== policy.repository ||
    String(part?.artifact?.runId) !== match[1] ||
    proof?.runnerRef !== `github:${policy.repository}:${match[1]}:attempt-${match[2]}` ||
    !Number.isSafeInteger(proof.checkedAt) ||
    proof.checkedAt < 0 ||
    proof.checkedAt > now ||
    proof.job?.status !== 'completed' ||
    !new RegExp(
      `^github:${match[1]}:attempt-${match[2]}:job-[1-9][0-9]*:(?:success|failure|cancelled|timed_out):source-${part.codeSha}$`,
    ).test(proof.job?.evidenceRef ?? '') ||
    proof.cloud?.kind !== 'stopped-site-html-batch' ||
    proof.cloud.status !== 'quiescent' ||
    typeof proof.cloud.operationId !== 'string' ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(proof.cloud.operationId) ||
    !/^[a-f0-9]{64}$/.test(proof.cloud.observedHash ?? '') ||
    proof.cloud.evidenceRef !==
      `candidate:${part.artifact.artifactId}:batch:${proof.cloud.observedHash}:three-cache-modes:absent:seo-catalog-region-${match[1]}-${match[2]}`
  )
    fail();
  const preserved = { runId, proof, sha256: identity(proof) };
  const latest = status.target.lastReconciliation;
  if (
    identity(latest) !== identity(proof) &&
    identity(latest?.inheritedReconciliation) !== identity(preserved)
  )
    fail();
  return preserved;
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
    typeof receipt.cleaned !== 'boolean' ||
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
      !['health', 'seed', 'prepare.step', 'recovery.clear'].includes(call.action) ||
      !['completed', 'failed', 'readback-confirmed'].includes(call.state) ||
      typeof call.requestId !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,200}$/.test(call.requestId)
    )
      fail();
}

function checkReleaseReceipt(receipt, context) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.purpose !== 'release-regional-v1' ||
    receipt.ownerRunId !== context.ownerRunId ||
    receipt.runnerRef !== context.runnerRef ||
    receipt.targetId !== context.targetId ||
    receipt.environment !== context.policy.envId ||
    receipt.codeSha !== context.codeSha ||
    receipt.functionName !== context.releaseName ||
    receipt.created !== true ||
    typeof receipt.cleaned !== 'boolean' ||
    receipt.unconfirmed !== false ||
    receipt.websiteWrites !== 0 ||
    receipt.businessWrites !== 0 ||
    !Array.isArray(receipt.calls) ||
    !receipt.calls.length ||
    receipt.calls.length > 50000 ||
    !receipt.calls.some((row) => row.method === 'health' && row.state === 'completed')
  )
    fail();
  for (const call of receipt.calls)
    if (
      !['health', 'status', 'runStatus', 'acquire', 'renew', 'reconcile', 'release'].includes(
        call?.method,
      ) ||
      !['completed', 'failed', 'readback-confirmed'].includes(call.state) ||
      !/^[A-Za-z0-9:_-]{1,200}$/.test(call.operationId ?? '')
    )
      fail();
}

async function assertNoHttp(environment, names, policy) {
  for (const name of names) {
    const result = await environment.getAccessService().getAccessList({ name });
    if (
      typeof result?.RequestId !== 'string' ||
      !result.RequestId.trim() ||
      (Object.hasOwn(result, 'Total') && result.Total !== 0) ||
      !Array.isArray(result.APISet) ||
      result.APISet.length
    )
      fail();
  }
  let count = 0;
  let total;
  const domains = new Set();
  for (let offset = 0; offset < 1000; offset += 100) {
    const result = await environment
      .getEnvService()
      .describeHttpServiceRoute({ EnvId: policy.envId, Offset: offset, Limit: 100 });
    if (
      !result?.RequestId ||
      !Number.isSafeInteger(result.TotalCount) ||
      result.TotalCount < 0 ||
      result.TotalCount > 1000 ||
      !Array.isArray(result.Domains) ||
      result.Domains.length > 100 ||
      (total !== undefined && result.TotalCount !== total)
    )
      fail();
    total = result.TotalCount;
    for (const domain of result.Domains) {
      if (!domain || typeof domain.Domain !== 'string' || !Array.isArray(domain.Routes ?? []))
        fail();
      if (domains.has(domain.Domain)) fail();
      domains.add(domain.Domain);
      for (const route of domain.Routes ?? []) {
        if (
          typeof route?.UpstreamResourceName !== 'string' ||
          typeof route.UpstreamResourceType !== 'string'
        )
          fail();
        if (names.some((name) => route.UpstreamResourceName.includes(name))) fail();
      }
    }
    count += result.Domains.length;
    if (count === total) return;
    if (count > total || result.Domains.length !== 100) fail();
  }
  fail();
}

function ownedWorker(detail, name, kind, context) {
  if (
    detail?.FunctionName !== name ||
    detail.Description !== `channel-${kind}-regional-v1` ||
    detail.Runtime !== 'Nodejs20.19' ||
    detail.Type !== 'Event' ||
    detail.Handler !== 'index.main' ||
    detail.Namespace !== context.policy.envId ||
    detail.Timeout !== 45 ||
    detail.MemorySize !== 256 ||
    typeof detail.FunctionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(detail.FunctionId) ||
    typeof detail.AddTime !== 'string' ||
    !detail.AddTime ||
    detail.AddTime.length > 128 ||
    typeof detail.ModTime !== 'string' ||
    !detail.ModTime ||
    detail.ModTime.length > 128 ||
    !Number.isSafeInteger(detail.CodeSize) ||
    detail.CodeSize < 1 ||
    !Array.isArray(detail.Layers) ||
    detail.Layers.length ||
    detail.Status !== 'Active' ||
    detail.AvailableStatus !== 'Available' ||
    !Array.isArray(detail.Triggers) ||
    detail.Triggers.length ||
    !Array.isArray(detail.Environment?.Variables)
  )
    fail();
  const variables = Object.fromEntries(
    detail.Environment.Variables.map((row) => [row.Key, row.Value]),
  );
  if (Object.keys(variables).length !== detail.Environment.Variables.length) fail();
  const prefix = kind === 'catalog' ? 'CATALOG' : 'RELEASE';
  if (
    variables.TCB_ENV !== context.policy.envId ||
    variables[`${prefix}_REGIONAL_TARGET_ID`] !== context.targetId ||
    variables[`${prefix}_REGIONAL_SITE_ORIGIN`] !== context.policy.siteOrigin ||
    variables[`${prefix}_REGIONAL_RUNNER_REF`] !== context.runnerRef ||
    !/^[a-f0-9]{64}$/.test(variables[`${prefix}_REGIONAL_TOKEN_DIGEST`] ?? '') ||
    (kind === 'catalog'
      ? variables.CATALOG_REGIONAL_RUN_ID !== context.ownerRunId
      : variables.RELEASE_REGIONAL_OWNER_RUN_ID !== context.ownerRunId ||
        variables.RELEASE_REGIONAL_REPOSITORY !== context.policy.repository)
  )
    fail();
  return identity({
    name,
    kind,
    variables,
    codeHash: detail.CodeSha256 ?? null,
    namespace: detail.Namespace,
    functionId: detail.FunctionId,
    addedAt: detail.AddTime,
    modifiedAt: detail.ModTime,
    bytes: detail.CodeSize,
    timeout: detail.Timeout,
    memory: detail.MemorySize,
    layers: detail.Layers,
    description: detail.Description,
    runtime: detail.Runtime,
    type: detail.Type,
    handler: detail.Handler,
    triggers: detail.Triggers,
  });
}

async function rejectedEmptyRequest(functions, name, kind, context) {
  const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
  const reject = (reason, response, cause) => {
    const requestId = response?.RequestId ?? cause?.requestId;
    throw Object.assign(Error(unproven), {
      code: unproven,
      probeDiagnostic: {
        reason,
        ...(safeId(requestId) ? { requestId } : {}),
        ...(['API_ERROR', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(
          cause?.code,
        )
          ? { sdkCode: cause.code }
          : {}),
      },
    });
  };
  let response;
  try {
    response = await functions.invokeFunction(name, {});
  } catch (cause) {
    reject('transport', null, cause);
  }
  if (
    !safeId(response?.RequestId) ||
    typeof response.ErrMsg !== 'string' ||
    response.ErrMsg.trim() ||
    typeof response.RetMsg !== 'string' ||
    Buffer.byteLength(response.RetMsg) > 8192
  )
    reject('response-shape', response);
  // Manager flattens SCF Invoke.Result. RetCode/InvokeFinished are function-log response fields.
  // InvokeResult is deprecated; official examples use both 0 and 200. The fixed returned
  // rejection and request identity below remain required even when that field is absent.
  if (
    (Object.hasOwn(response, 'RetCode') && response.RetCode !== 0) ||
    (Object.hasOwn(response, 'InvokeFinished') && response.InvokeFinished !== 1) ||
    (Object.hasOwn(response, 'InvokeResult') && ![0, 200].includes(response.InvokeResult)) ||
    (Object.hasOwn(response, 'FunctionRequestId') && !safeId(response.FunctionRequestId)) ||
    (!safeId(response.FunctionRequestId) &&
      !(response.RetCode === 0 && response.InvokeFinished === 1)) ||
    (Object.hasOwn(response, 'Duration') &&
      (typeof response.Duration !== 'number' ||
        !Number.isFinite(response.Duration) ||
        response.Duration < 0))
  )
    reject('invocation-status', response);
  let result;
  try {
    result = JSON.parse(response.RetMsg);
  } catch {
    reject('return-json', response);
  }
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.ok !== false ||
    result.codeSha !== context.codeSha ||
    result.purpose !== `${kind === 'catalog' ? 'catalog-seo' : 'release'}-regional-v1` ||
    result.error?.code !==
      (kind === 'catalog' ? 'REGIONAL_INVALID_REQUEST' : 'RELEASE_REGIONAL_REQUEST') ||
    (kind === 'catalog'
      ? result.runId !== context.ownerRunId
      : result.ownerRunId !== context.ownerRunId ||
        result.runnerRef !== context.runnerRef ||
        result.targetId !== context.targetId ||
        result.envId !== context.policy.envId)
  )
    reject('handler-identity', response);
  return response.RequestId;
}

async function settlePreparationWorkers({
  functions,
  manager,
  onCleanup,
  wait,
  context,
  catalogReceipt,
  loadReleaseReceipt,
  checkpoint,
  beforeDelete,
  now,
}) {
  const names = [context.functionName, context.releaseName];
  const fixedManager = () => {
    if (
      !manager ||
      manager.functions !== functions ||
      manager.getManagerConfig().envId !== context.policy.envId ||
      manager.getManagerConfig().region !== context.policy.region
    )
      fail();
  };
  if (manager) fixedManager();
  const listed = await functionInventory(functions, context.policy.envId);
  const present = names.filter((name) => listed.includes(name));
  if (!present.length && catalogReceipt.cleaned) return null;
  fixedManager();
  if (typeof onCleanup !== 'function') fail();
  if (present.includes(context.functionName) && catalogReceipt.cleaned) fail();
  if (present.includes(context.releaseName)) {
    const originalRelease = await loadReleaseReceipt();
    checkReleaseReceipt(originalRelease, context);
    if (originalRelease.cleaned) fail();
  }
  const supplementary = {
    schemaVersion: 1,
    purpose: 'stopped-catalog-preparation-cleanup',
    preparationRunId: context.ownerRunId,
    dirtyRunId: context.dirtyRunId,
    codeSha: context.codeSha,
    environment: context.policy.envId,
    targetId: context.targetId,
    observedAt: new Date(now()).toISOString(),
    websiteWrites: 0,
    businessWrites: 0,
    functions: names.map((name) => ({ name, state: listed.includes(name) ? 'pending' : 'absent' })),
  };
  await onCleanup(structuredClone(supplementary));
  if (present.length) {
    const environment = manager.currentEnvironment();
    if (environment.getEnvId() !== context.policy.envId) fail();
    const bound = () => {
      if (
        manager.getManagerConfig().envId !== context.policy.envId ||
        manager.getManagerConfig().region !== context.policy.region ||
        environment.getEnvId() !== context.policy.envId
      )
        fail();
    };
    const fingerprints = new Map();
    await assertNoHttp(environment, present, context.policy);
    for (const name of present) {
      bound();
      const kind = name === context.functionName ? 'catalog' : 'release';
      const detail = await functions.getFunctionDetail(name);
      const fingerprint = ownedWorker(detail, name, kind, context);
      fingerprints.set(name, fingerprint);
      const row = supplementary.functions.find((item) => item.name === name);
      let probeRequestId;
      try {
        probeRequestId = await rejectedEmptyRequest(functions, name, kind, context);
      } catch (cause) {
        row.state = 'probe-failed';
        row.probeDiagnostic = cause.probeDiagnostic;
        await onCleanup(structuredClone(supplementary));
        throw cause;
      }
      Object.assign(row, {
        functionId: detail.FunctionId,
        identitySha256: fingerprint,
        codeSha: context.codeSha,
        probe: 'empty-request-rejected-before-database',
        probeRequestId,
      });
    }
    await onCleanup(structuredClone(supplementary));
    for (const name of present) {
      bound();
      await checkpoint();
      await assertNoHttp(environment, [name], context.policy);
      const kind = name === context.functionName ? 'catalog' : 'release';
      if (
        ownedWorker(await functions.getFunctionDetail(name), name, kind, context) !==
        fingerprints.get(name)
      )
        fail(changed);
      const row = supplementary.functions.find((item) => item.name === name);
      row.state = 'deleting';
      await onCleanup(structuredClone(supplementary));
      beforeDelete();
      // The higher-level deleteFunction also deletes legacy HTTP bindings. This port cannot.
      try {
        await manager.commonService('tcb', '2018-06-08').call({
          Action: 'DeleteFunction',
          Param: { EnvId: context.policy.envId, FunctionName: name },
        });
      } catch {
        // A lost reply proves nothing. Only the complete inventory below may confirm absence.
      }
      let absent = false;
      for (let round = 0; round < 6; round++) {
        if (round) await wait(250 * 2 ** (round - 1));
        bound();
        if (!(await functionInventory(functions, context.policy.envId)).includes(name)) {
          absent = true;
          break;
        }
      }
      if (!absent) fail('CATALOG_PREPARATION_CLEANUP_NEEDS_READBACK');
      row.state = 'absent';
      await onCleanup(structuredClone(supplementary));
    }
  }
  const after = await functionInventory(functions, context.policy.envId);
  if (names.some((name) => after.includes(name)))
    fail('CATALOG_PREPARATION_CLEANUP_NEEDS_READBACK');
  await checkpoint();
  return supplementary;
}

/** Release only a stopped preparation whose exact receipts prove that website delivery never began. */
export async function recoverCatalogPreparation({
  coordinator,
  github,
  policy,
  functions,
  readPreparationRun,
  loadEvidence,
  manager,
  onCleanup,
  wait = pause,
  now = Date.now,
}) {
  let reconciling = false;
  let cleanupIssued = false;
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
    const dirtyRunId = status.target.dirtyRunId;
    const dirtyRun = dirtyRunId === null ? null : await readPreparationRun(dirtyRunId);
    const inheritedReconciliation = checkInheritedDirty(status, dirtyRun, policy, now());
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
    const checkpoint = async () => {
      if ((await readPreparationRun(ownerRunId)) !== null) fail(changed);
      const current = await coordinator.status({ scopeKey: 'site' });
      if (
        !noHosting(current) ||
        identity(current.target) !== identity(status.target) ||
        identity(current.scope) !== identity(status.scope) ||
        (dirtyRunId !== null &&
          identity(await readPreparationRun(dirtyRunId)) !== identity(dirtyRun))
      )
        fail(changed);
    };
    const supplementalRecovery = await settlePreparationWorkers({
      functions,
      manager,
      onCleanup,
      wait,
      catalogReceipt: evidence,
      context: {
        policy,
        ownerRunId,
        targetId,
        functionName,
        releaseName: `seo-release-region-${match[1]}-${match[2]}`,
        runnerRef: lease.runnerRef,
        codeSha: run.head_sha,
        dirtyRunId,
      },
      loadReleaseReceipt: () =>
        loadEvidence({
          run,
          job,
          ownerRunId,
          artifactName,
          regionalPath: 'release-regional/result.json',
        }),
      checkpoint,
      beforeDelete: () => {
        cleanupIssued = true;
      },
      now,
    });
    if ((await readPreparationRun(ownerRunId)) !== null) fail();
    const current = await coordinator.status({ scopeKey: 'site' });
    if (
      !noHosting(current) ||
      current.target.version !== status.target.version ||
      identity(current.target) !== identity(status.target) ||
      identity(current.scope) !== identity(status.scope) ||
      (dirtyRunId !== null && identity(await readPreparationRun(dirtyRunId)) !== identity(dirtyRun))
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
        ...(inheritedReconciliation ? { inheritedReconciliation } : {}),
      },
    });
    const released = await coordinator.status({ scopeKey: 'site' });
    if (identity(released.scope?.baseline) !== identity(status.scope.baseline)) fail(changed);
    if (dirtyRunId === null) assertCleanAcceptedSite(released);
    else if (
      released.state !== 'recovery-required' ||
      released.target.lease !== null ||
      released.target.currentRunId !== null ||
      released.target.unresolvedOperation !== null ||
      released.pendingStep !== null ||
      released.target.dirtyRunId !== dirtyRunId ||
      identity(await readPreparationRun(dirtyRunId)) !== identity(dirtyRun) ||
      identity(released.target.lastReconciliation?.inheritedReconciliation) !==
        identity(inheritedReconciliation)
    )
      fail('CATALOG_PREPARATION_RECOVERY_NEEDS_READBACK');
    return supplementalRecovery ? { ...released, supplementalRecovery } : released;
  } catch (error) {
    if ([unproven, changed, 'CATALOG_PREPARATION_CLEANUP_NEEDS_READBACK'].includes(error?.code))
      throw error;
    fail(
      reconciling
        ? 'CATALOG_PREPARATION_RECOVERY_NEEDS_READBACK'
        : cleanupIssued
          ? 'CATALOG_PREPARATION_CLEANUP_NEEDS_READBACK'
          : unproven,
    );
  }
}
