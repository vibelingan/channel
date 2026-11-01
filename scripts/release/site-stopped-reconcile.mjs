import { parse } from 'yaml';
import { fetchFully } from '../smoke-http.mjs';
import { verifyReleaseArtifact } from './artifact.mjs';
import {
  assertHostingBatchMembers,
  hostingBatchBeforeHash,
  hostingBatchHash,
  mapHostingBounded,
} from './hosting-batches.mjs';
import { verifyHostingObject } from './hosting-readback.mjs';
import { identity, isHash } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';

const unproven = 'SITE_STOPPED_RECONCILE_UNPROVEN';
const changed = 'SITE_STOPPED_RECONCILE_CHANGED';
const needsReadback = 'SITE_STOPPED_RECONCILE_NEEDS_READBACK';
const terminal = new Set(['success', 'failure', 'cancelled', 'timed_out']);
const workflowPath = '.github/workflows/seo-static-canary.yml';
const deliveryPath = '.github/workflows/seo-site-delivery.yml';
const fail = (code = unproven) => {
  throw Object.assign(Error(code), { code });
};

/** Resolve only an ended writer's exact pending HTML batch. This port cannot upload or activate. */
export async function recoverStoppedSiteDelivery({
  coordinator,
  github,
  policy,
  runId,
  loadCandidate,
  verifyQuiescence,
  request = fetchFully,
  now = Date.now,
}) {
  let reconciling = false;
  let stage = 'starting';
  try {
    const targetId = normalizePolicy(policy).targetId;
    const match = /^site-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(runId ?? '');
    if (
      !match ||
      policy.repository !== 'vibelingan/channel' ||
      policy.workflowPath !== workflowPath ||
      !['refs/heads/feat/seo-foundation', 'refs/heads/test'].includes(policy.trustedRef) ||
      coordinator.targetId !== targetId ||
      typeof loadCandidate !== 'function' ||
      typeof verifyQuiescence !== 'function'
    )
      fail();
    const status = await coordinator.status({ scopeKey: 'site' });
    const run = await coordinator.runStatus(runId);
    const { lease, step } = pendingHtmlBatch(status, run, targetId, runId, now());
    if (lease.runnerRef !== `github:${policy.repository}:${match[1]}:attempt-${match[2]}`) fail();
    stage = 'github-run';
    const githubRun = await github.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
    if (
      String(githubRun.id) !== match[1] ||
      String(githubRun.run_attempt) !== match[2] ||
      !Number.isSafeInteger(githubRun.repository?.id) ||
      githubRun.repository.id < 1 ||
      githubRun.repository.id !== githubRun.head_repository?.id ||
      githubRun.repository.full_name !== policy.repository ||
      githubRun.head_repository.full_name !== policy.repository ||
      githubRun.path !== policy.workflowPath ||
      githubRun.head_branch !== policy.trustedRef.slice(11) ||
      githubRun.event !== 'workflow_dispatch' ||
      githubRun.status !== 'completed' ||
      !terminal.has(githubRun.conclusion) ||
      !/^[a-f0-9]{40}$/.test(githubRun.head_sha ?? '') ||
      run.composition.static.codeSha !== githubRun.head_sha ||
      run.composition.static.artifact.runId !== match[1]
    )
      fail();
    stage = 'github-jobs';
    const { job, stoppedAt } = await stoppedJobs(github, match[1], match[2], githubRun, now());
    stage = 'github-workflow';
    await trustedWorkflow(github, githubRun.head_sha, policy);
    stage = 'candidate';
    const input = await loadCandidate({ run, artifact: run.composition.static.artifact });
    const candidate = verifyReleaseArtifact({ ...input, now: now() });
    if (
      input.acceptedSeal ||
      candidate.mode !== 'candidate' ||
      identity(candidate.envelope.artifact) !== identity(run.composition.static.artifact) ||
      candidate.envelope.codeSha !== run.composition.static.codeSha ||
      candidate.envelope.releaseId !== run.composition.static.releaseId ||
      candidate.envelope.releaseId !== runId ||
      candidate.envelope.target.envId !== policy.envId ||
      candidate.envelope.target.siteOrigin !== policy.siteOrigin ||
      candidate.envelope.scope.kind !== 'site' ||
      candidate.envelope.functions.length ||
      input.policy.repository !== policy.repository ||
      input.policy.workflowPath !== policy.workflowPath ||
      input.policy.ref !== policy.trustedRef ||
      input.run.runId !== match[1] ||
      input.run.headSha !== githubRun.head_sha
    )
      fail();
    const entries = new Map(candidate.staticManifest.entries.map((entry) => [entry.path, entry]));
    for (const member of step.members) {
      const entry = entries.get(member.path);
      if (!entry || entry.bytes !== member.bytes || entry.sha256 !== member.sha256) fail();
    }
    const context = Object.freeze({
      runId,
      targetId,
      runnerRef: lease.runnerRef,
      codeSha: githubRun.head_sha,
      githubRunId: match[1],
      attempt: match[2],
      jobId: job.id,
      pendingOperationId: step.operationId,
      functionName: `seo-catalog-region-${match[1]}-${match[2]}`,
      stoppedAt,
    });
    stage = 'quiescence-before';
    await quiet(verifyQuiescence, context, now);
    stage = 'http-batch';
    const observed = await mapHostingBounded(step.members, 4, (entry) =>
      verifyHostingObject({
        target: { envId: policy.envId, site: policy.siteOrigin },
        entry,
        request,
      }),
    );
    const observedHash = hostingBatchHash(
      step.members.map((member, index) => ({
        path: member.path,
        bytes: observed[index].bytes,
        sha256: observed[index].sha256,
      })),
    );
    if (observedHash !== step.afterHash) fail();
    stage = 'quiescence-after';
    await quiet(verifyQuiescence, context, now);
    stage = 'recheck';
    const current = await coordinator.status({ scopeKey: 'site' });
    const currentRun = await coordinator.runStatus(runId);
    if (
      current.target.version !== status.target.version ||
      identity(current.target) !== identity(status.target) ||
      identity(current.scope) !== identity(status.scope) ||
      identity(current.pendingStep) !== identity(step) ||
      identity(currentRun) !== identity(run)
    )
      fail(changed);
    pendingHtmlBatch(current, currentRun, targetId, runId, now());
    stage = 'reconcile';
    reconciling = true;
    await coordinator.reconcile({
      expectedVersion: status.target.version,
      expectedFence: lease.fence,
      proof: {
        runnerRef: lease.runnerRef,
        checkedAt: now(),
        job: {
          status: 'completed',
          evidenceRef: `github:${match[1]}:attempt-${match[2]}:job-${job.id}:${job.conclusion}:source-${githubRun.head_sha}`,
        },
        cloud: {
          status: 'quiescent',
          kind: 'stopped-site-html-batch',
          operationId: step.operationId,
          observedHash,
          evidenceRef: `candidate:${candidate.envelope.artifact.artifactId}:batch:${observedHash}:three-cache-modes:absent:${context.functionName}`,
        },
      },
    });
    stage = 'result-readback';
    const released = await coordinator.status({ scopeKey: 'site' });
    const failedRun = await coordinator.runStatus(runId);
    if (
      released.state !== 'recovery-required' ||
      released.target.lease !== null ||
      released.target.currentRunId !== null ||
      released.target.unresolvedOperation !== null ||
      released.pendingStep !== null ||
      released.target.dirtyRunId !== runId ||
      identity(released.scope) !== identity(status.scope) ||
      failedRun.state !== 'FAILED' ||
      failedRun.accepted ||
      failedRun.verifiedSteps !== run.verifiedSteps ||
      failedRun.verifiedWrites !== run.verifiedWrites
    )
      fail(needsReadback);
    return {
      status: 'reconciled',
      runId,
      observedHash,
      verifiedUrls: observed.length,
      websiteWrites: 0,
      businessWrites: 0,
      recoveryRequired: true,
    };
  } catch (error) {
    const code = [unproven, changed, needsReadback].includes(error?.code)
      ? error.code
      : reconciling
        ? needsReadback
        : unproven;
    const diagnostic = { code, reconcileStage: stage };
    if (
      typeof error?.code === 'string' &&
      error.code !== code &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(error.code)
    )
      diagnostic.underlyingCode = error.code;
    throw Object.assign(Error(code), diagnostic);
  }
}

function pendingHtmlBatch(status, run, targetId, runId, now) {
  const lease = status.target?.lease;
  const step = status.pendingStep;
  if (
    !Number.isSafeInteger(now) ||
    status.state !== 'stalled' ||
    status.targetId !== targetId ||
    !lease ||
    now < lease.expiresAt ||
    lease.ownerRunId !== runId ||
    status.target.currentRunId !== runId ||
    status.target.dirtyRunId !== runId ||
    status.scope?.scopeKey !== 'site' ||
    !status.scope.baseline?.sourceRunId ||
    run?.state !== 'RUNNING' ||
    run.accepted ||
    run.runId !== runId ||
    run.targetId !== targetId ||
    run.scopeKey !== 'site' ||
    !['publish', 'reconcile'].includes(run.kind) ||
    run.ownerRunId !== lease.ownerRunId ||
    run.fence !== lease.fence ||
    run.acquiredVersion !== lease.acquiredVersion ||
    Object.keys(run.composition).join(',') !== 'static' ||
    run.deliveredComponents?.join(',') !== 'static' ||
    run.verifiedWrites !== run.verifiedSteps ||
    !step ||
    step.targetId !== targetId ||
    step.runId !== runId ||
    step.fence !== run.fence ||
    step.sequence !== run.verifiedSteps ||
    step.sequence >= run.plan.stepCount - 1 ||
    step.kind !== 'write' ||
    step.component !== 'static' ||
    !['submitted', 'unknown'].includes(step.state) ||
    step.removals ||
    !isHash(step.intentHash) ||
    step.planSha256 !== run.plan.planSha256 ||
    status.target.unresolvedOperation?.runId !== runId ||
    status.target.unresolvedOperation.stepId !== step.stepId ||
    status.target.unresolvedOperation.operationId !== step.operationId
  )
    fail();
  assertHostingBatchMembers(step.members);
  const hash = hostingBatchHash(step.members);
  if (
    step.members.some((entry) => !entry.path.endsWith('.html')) ||
    step.afterHash !== hash ||
    step.beforeHash !== hostingBatchBeforeHash(step.members) ||
    step.subject !== `upload-batch:${hash}` ||
    step.verifySubject !== `read-batch:${hash}`
  )
    fail();
  return { lease, step };
}

async function quiet(verify, context, now) {
  const answer = await verify(context);
  if (
    !answer ||
    ['runId', 'targetId', 'runnerRef', 'codeSha', 'pendingOperationId', 'functionName'].some(
      (key) => answer[key] !== context[key],
    ) ||
    answer.functionsAbsent !== true ||
    answer.oldJobCompleted !== true ||
    !Number.isSafeInteger(answer.checkedAt) ||
    answer.checkedAt < context.stoppedAt ||
    answer.checkedAt > now() ||
    now() - answer.checkedAt > 60000
  )
    fail();
}

async function stoppedJobs(github, runId, attempt, run, now) {
  const jobs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const response = await github.api(
      `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
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
    !Number.isSafeInteger(job.id) ||
    job.id < 1 ||
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
      String(row.run_id) !== runId
    )
      fail();
    stoppedAt = Math.max(stoppedAt, completedAt);
  }
  if (now - stoppedAt < 120000) fail();
  return { job, stoppedAt };
}

async function readWorkflow(github, path, sha) {
  const response = await github.get(`/contents/${path}?ref=${sha}`);
  if (response.status !== 200) fail();
  const file = JSON.parse(response.body.toString('utf8'));
  if (
    file.type !== 'file' ||
    file.path !== path ||
    file.encoding !== 'base64' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 1024 * 1024 ||
    typeof file.content !== 'string'
  )
    fail();
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size) fail();
  return parse(bytes.toString('utf8'));
}

async function trustedWorkflow(github, sha, policy) {
  const workflow = await readWorkflow(github, policy.workflowPath, sha);
  const delivery = await readWorkflow(github, deliveryPath, sha);
  const wrapper = workflow.jobs?.site_delivery;
  const job = delivery.jobs?.site;
  const dispatch = workflow.on?.workflow_dispatch?.inputs?.mode?.options;
  if (
    !dispatch?.includes('site-delivery') ||
    !dispatch.includes('catalog-bootstrap') ||
    wrapper?.uses !== `./${deliveryPath}` ||
    wrapper.if !==
      "${{ (github.ref == 'refs/heads/feat/seo-foundation' || github.ref == 'refs/heads/test') && (inputs.mode == 'site-delivery' || inputs.mode == 'catalog-bootstrap') }}" ||
    job?.if !==
      "${{ (github.ref == 'refs/heads/feat/seo-foundation' || github.ref == 'refs/heads/test') && github.event_name == 'workflow_dispatch' }}" ||
    job.environment !== 'test' ||
    !job.steps?.some(
      (step) =>
        step.uses === 'actions/checkout@v4' &&
        step.with?.ref === '${{ github.sha }}' &&
        step.with['persist-credentials'] === false,
    ) ||
    !job.steps?.some(
      (step) =>
        step.uses === 'actions/github-script@v7' &&
        step.with?.script?.includes(
          "spawn('./apps/site/node_modules/.bin/tsx', ['scripts/run-site-delivery.ts']",
        ),
    )
  )
    fail();
}
