import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { identity } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';
import { siteArtifact } from './site-payload.mjs';
import { SITE_DELIVERY_POLICY, assertCleanAcceptedSite } from './site-policy.mjs';

const stages = new Set([
  'starting',
  'invocation-checked',
  'ci-approved',
  'lease-held',
  'stopped-owner-checking',
  'stopped-owner-released',
  'source-downloading',
  'source-verified',
  'archive-saving',
  'archive-saved',
  'archive-readback',
  'archive-verified',
  'lease-released',
  'failed',
  'complete',
]);
const sdkStages = new Set([
  'task-ready',
  'task-started',
  'hashing',
  'uploading',
  'deadline',
  'multipart-initialize',
  'multipart-list',
  'multipart-parts-list',
  'multipart-part',
  'multipart-complete',
  'multipart-abort',
  'object-request',
]);
const codes = new Set([
  'SITE_ARCHIVE_INVOCATION_INVALID',
  'SITE_ARCHIVE_TARGET_CHANGED',
  'SITE_ARCHIVE_BASELINE_CHANGED',
  'SITE_ARCHIVE_SOURCE_CHANGED',
  'SITE_ARCHIVE_FAILED',
  'SITE_ARCHIVE_PRIOR_JOB_UNPROVEN',
  'LEASE_LOST',
  'LEASE_HELD',
  'LEASE_BUSY',
  'LEASE_STALLED',
  'INVALID_RECONCILIATION',
  'TARGET_POLICY_MISMATCH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ARCHIVE_SOURCE_MISMATCH',
  'ARCHIVE_PROGRESS_INVALID',
  'ARCHIVE_SOURCE_CHANGED',
  'ARCHIVE_LOCAL_SIZE_MISMATCH',
]);
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const safeCode = (value) =>
  typeof value === 'string' &&
  (codes.has(value) ||
    /^http-[1-5][0-9]{2}$/.test(value) ||
    ['timeout', 'unavailable', 'too-large', 'unconfirmed'].includes(value))
    ? value
    : 'unconfirmed';

export function assertSiteArchiveInvocation(env) {
  const p = SITE_DELIVERY_POLICY;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== p.repository ||
    env.GITHUB_REF !== p.trustedRef ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !== `${p.repository}/${p.workflowPath}@${p.trustedRef}` ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    env.TCB_ENV_ID !== p.envId ||
    env.SITE_URL !== p.siteOrigin ||
    env.CLOUDBASE_REGION !== p.region ||
    env.SITE_ARCHIVE_CONFIRM !== 'CURRENT_ACCEPTED_SITE_ONLY' ||
    !env.TENCENTCLOUD_SECRETID ||
    !env.TENCENTCLOUD_SECRETKEY ||
    !env.GITHUB_TOKEN
  )
    fail('SITE_ARCHIVE_INVOCATION_INVALID');
  return p;
}

/** A dead archive worker has no hosting operation to finish. Its exact executed job must prove that. */
async function releaseStoppedArchive({ coordinator, github, policy, status, observe, now }) {
  const lease = status.target?.lease;
  const match = /^site-archive-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(lease?.ownerRunId ?? '');
  const noHostingWork = (value) =>
    value.state === 'stalled' &&
    value.target?.lease &&
    !value.target.currentRunId &&
    !value.target.dirtyRunId &&
    !value.target.unresolvedOperation &&
    !value.pendingStep &&
    value.scope?.baseline;
  if (
    !match ||
    !github ||
    !noHostingWork(status) ||
    now() < lease.expiresAt ||
    lease.runnerRef !== `github:${policy.repository}:${match[1]}:attempt-${match[2]}`
  )
    fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  observe({ stage: 'stopped-owner-checking' });
  const run = await github.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
  const terminal = new Set(['success', 'failure', 'cancelled', 'timed_out']);
  if (
    String(run.id) !== match[1] ||
    String(run.run_attempt) !== match[2] ||
    run.repository?.full_name !== policy.repository ||
    run.head_repository?.full_name !== policy.repository ||
    run.path !== policy.workflowPath ||
    run.head_branch !== policy.trustedRef.slice(11) ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    !terminal.has(run.conclusion) ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')
  )
    fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  const jobs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const answer = await github.api(
      `/actions/runs/${match[1]}/attempts/${match[2]}/jobs?per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(answer.total_count) ||
      answer.total_count < 1 ||
      answer.total_count > 1000 ||
      !Array.isArray(answer.jobs) ||
      answer.jobs.length > 100 ||
      (total !== undefined && total !== answer.total_count)
    )
      fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
    total = answer.total_count;
    jobs.push(...answer.jobs);
    if (jobs.length === total) break;
    if (answer.jobs.length !== 100 || jobs.length > total) fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  }
  const selected = jobs.filter((job) => job.name === 'site_archive');
  const job = selected[0];
  if (
    jobs.length !== total ||
    selected.length !== 1 ||
    !/^[1-9][0-9]*$/.test(String(job.id)) ||
    String(job.run_id) !== match[1] ||
    job.head_sha !== run.head_sha ||
    job.status !== 'completed' ||
    !terminal.has(job.conclusion) ||
    !Number.isFinite(Date.parse(job.started_at)) ||
    !Number.isFinite(Date.parse(job.completed_at)) ||
    Date.parse(job.completed_at) < Date.parse(job.started_at)
  )
    fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  const response = await github.get(`/contents/${policy.workflowPath}?ref=${run.head_sha}`);
  if (response.status !== 200) fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  const file = JSON.parse(response.body.toString('utf8'));
  if (
    file.type !== 'file' ||
    file.path !== policy.workflowPath ||
    file.encoding !== 'base64' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 1024 * 1024 ||
    typeof file.content !== 'string'
  )
    fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size) fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  const workflow = parse(bytes.toString('utf8'));
  const archiveJob = workflow.jobs?.site_archive;
  if (
    !workflow.on?.workflow_dispatch?.inputs?.mode?.options?.includes('site-archive') ||
    archiveJob?.if !==
      `\${{ github.ref == '${policy.trustedRef}' && inputs.mode == 'site-archive' }}` ||
    archiveJob.environment !== 'test' ||
    !archiveJob.steps?.some(
      (step) => step.run === './apps/site/node_modules/.bin/tsx scripts/archive-accepted-site.ts',
    )
  )
    fail('SITE_ARCHIVE_PRIOR_JOB_UNPROVEN');
  const current = await coordinator.status({ scopeKey: 'site' });
  if (
    !noHostingWork(current) ||
    current.target.version !== status.target.version ||
    identity(current.target.lease) !== identity(lease) ||
    identity(current.scope.baseline) !== identity(status.scope.baseline)
  )
    fail('SITE_ARCHIVE_BASELINE_CHANGED');
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
        kind: 'stopped-site-archive-only',
        operationId: null,
        observedHash: null,
        evidenceRef: `accepted:${status.scope.baseline.sourceRunId}:no-current-dirty-or-unresolved-hosting-operation`,
      },
    },
  });
  const released = await coordinator.status({ scopeKey: 'site' });
  if (identity(released.scope?.baseline) !== identity(status.scope.baseline))
    fail('SITE_ARCHIVE_BASELINE_CHANGED');
  assertCleanAcceptedSite(released);
  observe({ stage: 'stopped-owner-released' });
  return released;
}

/** Persist a fixed diagnostic vocabulary. SDK messages, credentials and signed URLs have no field here. */
export function createSiteArchiveDiagnostic({ file, now = Date.now, log = (_line) => {} }) {
  const record = {
    schemaVersion: 1,
    operation: 'site-archive',
    status: 'preflight',
    startedAt: now(),
    websiteWrites: 0,
    businessWrites: 0,
    events: [],
  };
  mkdirSync(dirname(file), { recursive: true });
  const observe = (event) => {
    const safe = { elapsedMs: Math.max(0, now() - record.startedAt) };
    if (event.kind === 'sdk') {
      if (!sdkStages.has(event.stage)) return;
      safe.kind = 'sdk';
      safe.stage = event.stage;
    } else if (event.kind === 'transfer') {
      if (
        !['put', 'read'].includes(event.action) ||
        !['complete', 'unconfirmed'].includes(event.outcome)
      )
        return;
      safe.kind = 'transfer';
      safe.action = event.action;
      safe.outcome = event.outcome;
      if (event.cause !== undefined) safe.cause = safeCode(event.cause);
    } else {
      if (!stages.has(event.stage)) return;
      safe.stage = event.stage;
    }
    for (const key of ['bytes', 'totalBytes', 'loadedBytes'])
      if (Number.isSafeInteger(event[key]) && event[key] >= 0) safe[key] = event[key];
    if (event.kind === 'transfer' && Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0)
      safe.transferElapsedMs = event.elapsedMs;
    if (typeof event.sha256 === 'string' && /^[a-f0-9]{64}$/.test(event.sha256))
      safe.sha256 = event.sha256;
    if (typeof event.executorSha === 'string' && /^[a-f0-9]{40}$/.test(event.executorSha))
      safe.executorSha = event.executorSha;
    if (
      typeof event.sourceRunId === 'string' &&
      /^site-[1-9][0-9]*-[1-9][0-9]*$/.test(event.sourceRunId)
    )
      safe.sourceRunId = event.sourceRunId;
    if (typeof event.artifactId === 'string' && /^[1-9][0-9]*$/.test(event.artifactId))
      safe.artifactId = event.artifactId;
    if (event.stage === 'failed') {
      record.status = 'failed';
      record.failureCode = safeCode(event.code);
    } else if (event.stage === 'complete') record.status = 'complete';
    else if (record.status === 'preflight') record.status = 'running';
    record.events.push(safe);
    if (record.events.length > 512) record.events.splice(1, 1);
    writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
    log(JSON.stringify(safe));
  };
  observe({ stage: 'starting' });
  return { observe, record };
}

/** Only private recovery objects and their registry may be written. No hosting adapter is accepted. */
export async function archiveAcceptedSite({
  coordinator,
  source,
  github = /** @type {null | ReturnType<typeof import('./github-read.mjs').createGithubReadClient>} */ (
    null
  ),
  retention,
  policy,
  owner,
  directory,
  observe,
  heartbeatMs = 30000,
  now = Date.now,
}) {
  let guard;
  let timer;
  let renewing;
  let heartbeatFailure;
  let heartbeatFailed = false;
  let result;
  let failure;
  let failed = false;
  try {
    if (coordinator.targetId !== normalizePolicy(policy).targetId)
      fail('SITE_ARCHIVE_TARGET_CHANGED');
    let initial = await coordinator.status({ scopeKey: 'site' });
    if (initial.state === 'stalled')
      initial = await releaseStoppedArchive({
        coordinator,
        github,
        policy,
        status: initial,
        observe,
        now,
      });
    const baseline = assertCleanAcceptedSite(initial);
    guard = await coordinator.acquire(owner);
    const checkpoint = async () => {
      if (heartbeatFailed) throw heartbeatFailure;
      await coordinator.renew(guard);
      const current = await coordinator.status({ scopeKey: 'site' });
      if (
        identity(current.scope?.baseline) !== identity(baseline) ||
        current.target.currentRunId ||
        current.target.dirtyRunId ||
        current.target.unresolvedOperation ||
        current.pendingStep ||
        current.state !== 'leased' ||
        current.target.lease?.ownerRunId !== owner.ownerRunId ||
        current.target.lease.fence !== guard.fence
      )
        fail('SITE_ARCHIVE_BASELINE_CHANGED');
    };
    await checkpoint();
    observe({ stage: 'lease-held', sourceRunId: baseline.sourceRunId });
    timer = setInterval(() => {
      if (renewing) return;
      renewing = checkpoint()
        .catch((error) => {
          heartbeatFailed = true;
          heartbeatFailure = error;
        })
        .finally(() => {
          renewing = null;
        });
    }, heartbeatMs);
    const run = await coordinator.runStatus(baseline.sourceRunId);
    if (
      run.state !== 'SUCCEEDED' ||
      run.scopeKey !== 'site' ||
      run.targetId !== coordinator.targetId ||
      run.accepted?.sourceRunId !== baseline.sourceRunId ||
      run.accepted.activationId !== baseline.activationId
    )
      fail('SITE_ARCHIVE_SOURCE_CHANGED');
    const artifact = run.composition.static.artifact;
    observe({
      stage: 'source-downloading',
      sourceRunId: run.runId,
      artifactId: artifact.artifactId,
    });
    mkdirSync(directory, { recursive: true });
    const sourceDirectory = join(directory, 'source');
    const metadata = await source.download(artifact.artifactId, sourceDirectory, {
      acceptedRunId: artifact.runId,
    });
    await checkpoint();
    const input = siteArtifact({
      directory: sourceDirectory,
      policy,
      run: metadata,
      acceptedSeal: run.accepted.seals.static,
      retainedProof: metadata.retainedProof ?? null,
    });
    if (identity(input.envelope.artifact) !== identity(artifact))
      fail('SITE_ARCHIVE_SOURCE_CHANGED');
    observe({ stage: 'source-verified', sourceRunId: run.runId, artifactId: artifact.artifactId });
    await checkpoint();
    observe({ stage: 'archive-saving' });
    await retention.save(input);
    await checkpoint();
    observe({ stage: 'archive-saved' });
    observe({ stage: 'archive-readback' });
    const readbackDirectory = join(directory, 'verified');
    const saved = await retention.download(artifact.artifactId, readbackDirectory);
    if (!saved) fail('SITE_ARCHIVE_SOURCE_CHANGED');
    const verified = siteArtifact({
      directory: readbackDirectory,
      policy,
      run: saved,
      acceptedSeal: run.accepted.seals.static,
      retainedProof: saved.retainedProof ?? null,
    });
    if (identity(verified.envelope.artifact) !== identity(artifact))
      fail('SITE_ARCHIVE_SOURCE_CHANGED');
    await checkpoint();
    observe({ stage: 'archive-verified' });
    result = {
      sourceRunId: run.runId,
      artifactId: artifact.artifactId,
      websiteWrites: 0,
      businessWrites: 0,
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (timer) clearInterval(timer);
    if (renewing) await renewing;
    if (!failed && heartbeatFailed) {
      failed = true;
      failure = heartbeatFailure;
    }
    if (guard) {
      try {
        await coordinator.release(guard);
        observe({ stage: 'lease-released' });
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  if (failed) {
    observe({ stage: 'failed', code: failure?.code });
    throw Object.assign(Error('SITE_ARCHIVE_FAILED; inspect the retained diagnostic'), {
      code: 'SITE_ARCHIVE_FAILED',
    });
  }
  observe({ stage: 'complete', ...result });
  return result;
}
