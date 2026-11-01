import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { identity } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';
import { siteArtifact } from './site-payload.mjs';
import { SITE_DELIVERY_POLICY, assertCleanAcceptedSite } from './site-policy.mjs';

const stages = new Set([
  'starting',
  'invocation-checked',
  'ci-approved',
  'lease-held',
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
  'multipart-part',
  'multipart-complete',
  'object-request',
]);
const codes = new Set([
  'SITE_ARCHIVE_INVOCATION_INVALID',
  'SITE_ARCHIVE_TARGET_CHANGED',
  'SITE_ARCHIVE_BASELINE_CHANGED',
  'SITE_ARCHIVE_SOURCE_CHANGED',
  'SITE_ARCHIVE_FAILED',
  'LEASE_LOST',
  'LEASE_HELD',
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
    for (const key of ['bytes', 'totalBytes', 'loadedBytes', 'elapsedMs'])
      if (Number.isSafeInteger(event[key]) && event[key] >= 0) safe[key] = event[key];
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
  retention,
  policy,
  owner,
  directory,
  observe,
  heartbeatMs = 30000,
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
    const initial = await coordinator.status({ scopeKey: 'site' });
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
