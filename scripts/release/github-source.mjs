import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFully } from '../smoke-http.mjs';
import { assertCanaryPolicy } from './canary.mjs';
import { createGithubReadClient } from './github-read.mjs';
import { freeze, isHash, sha256 } from './input.mjs';

const positiveId = (id) =>
  (typeof id !== 'number' || Number.isSafeInteger(id)) && /^[1-9][0-9]{0,19}$/.test(String(id));
export function validateInvocation(env, policy) {
  assertCanaryPolicy(policy);
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REPOSITORY !== policy.repository ||
    env.GITHUB_REF !== policy.trustedRef ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) ||
    !positiveId(env.GITHUB_RUN_ID) ||
    !positiveId(env.GITHUB_RUN_ATTEMPT) ||
    env.GITHUB_JOB !== 'canary'
  )
    throw new Error('Untrusted manual invocation');
  return freeze({
    codeSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    ownerRunId: `github-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}:canary`,
  });
}

export function validateArtifactSource({
  artifact,
  run,
  policy,
  now = Date.now(),
  allowCurrentRunId,
  acceptedSeal,
  artifactPrefix = 'static-canary-payload',
  maxBytes = 1_048_576,
}) {
  if (
    !['static-canary-payload', 'function-release-payload', 'function-compatibility-tests'].includes(
      artifactPrefix,
    ) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 134_217_728
  )
    throw new Error('Invalid artifact profile');
  const ref = policy.trustedRef.slice('refs/heads/'.length);
  // A completed component remains recoverable if a later step made the producer fail.
  // Callers obtain this seal from the authenticated release journal; candidates have no seal.
  const refSeal = acceptedSeal?.artifact;
  const acceptedFailure =
    run.status === 'completed' &&
    run.conclusion === 'failure' &&
    acceptedSeal?.schemaVersion === 1 &&
    typeof acceptedSeal.activationId === 'string' &&
    acceptedSeal.activationId.trim().length > 0 &&
    typeof acceptedSeal.releaseId === 'string' &&
    acceptedSeal.releaseId.trim().length > 0 &&
    acceptedSeal.codeSha === run.head_sha &&
    acceptedSeal.target?.envId === policy.envId &&
    acceptedSeal.target?.siteOrigin === policy.siteOrigin &&
    ((artifactPrefix === 'function-release-payload' && acceptedSeal.scope?.kind === 'site') ||
      (artifactPrefix === 'static-canary-payload' &&
        acceptedSeal.scope?.kind === 'canary' &&
        acceptedSeal.scope.prefix === policy.canaryPrefix)) &&
    refSeal?.repository === policy.repository &&
    refSeal.workflowPath === policy.workflowPath &&
    refSeal.runId === String(run.id) &&
    refSeal.artifactId === String(artifact.id) &&
    refSeal.expiresAt === artifact.expires_at &&
    isHash(refSeal.manifestSha256);
  if (
    !positiveId(artifact.id) ||
    !positiveId(run.id) ||
    !positiveId(run.run_attempt) ||
    artifact.expired !== false ||
    !(Date.parse(artifact.expires_at) > now) ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > maxBytes ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
    artifact.name !== `${artifactPrefix}-${run.id}-${run.run_attempt}` ||
    run.path !== policy.workflowPath ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== ref ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    run.repository?.full_name !== policy.repository ||
    run.head_repository?.full_name !== policy.repository ||
    !Number.isSafeInteger(run.repository.id) ||
    run.repository.id !== run.head_repository.id ||
    artifact.workflow_run?.repository_id !== run.repository.id ||
    artifact.workflow_run.head_repository_id !== run.repository.id ||
    artifact.workflow_run.id !== run.id ||
    artifact.workflow_run.head_sha !== run.head_sha ||
    artifact.workflow_run.head_branch !== ref ||
    !(
      (run.status === 'completed' && run.conclusion === 'success') ||
      acceptedFailure ||
      (String(run.id) === allowCurrentRunId &&
        run.status === 'in_progress' &&
        run.conclusion === null)
    )
  )
    throw new Error('Untrusted GitHub artifact source');
  return freeze({
    repository: policy.repository,
    workflowPath: run.path,
    event: run.event,
    ref: policy.trustedRef,
    headSha: run.head_sha,
    runId: String(run.id),
    artifact: {
      id: String(artifact.id),
      runId: String(run.id),
      expired: false,
      expiresAt: artifact.expires_at,
    },
  });
}

export function createGithubSource({ policy, token, request = fetchFully }) {
  assertCanaryPolicy(policy);
  if (typeof token !== 'string' || !token) throw new Error('GitHub read token required');
  const { get, api, requireCI } = createGithubReadClient({ policy, token, request });
  const metadata = async (artifactId, options = {}) => {
    if (!positiveId(artifactId)) throw new Error('Explicit artifact ID required');
    const artifact = await api(`/actions/artifacts/${artifactId}`);
    if (String(artifact.id) !== String(artifactId) || !positiveId(artifact.workflow_run?.id))
      throw new Error('GitHub artifact ID mismatch');
    const sourceName = new RegExp(
      `^static-canary-payload-${artifact.workflow_run.id}-([1-9][0-9]*)$`,
    ).exec(artifact.name);
    if (!sourceName) throw new Error('Untrusted canary artifact name');
    const run = await api(`/actions/runs/${artifact.workflow_run.id}/attempts/${sourceName[1]}`);
    return {
      metadata: validateArtifactSource({ artifact, run, policy, ...options }),
      digest: artifact.digest,
    };
  };
  return Object.freeze({
    api,
    requireCI,
    metadata,
    async download(artifactId, directory, options = {}) {
      const source = await metadata(artifactId, options);
      const response = await get(`/actions/artifacts/${artifactId}/zip`, { redirect: 'manual' });
      const location = new URL(response.headers.get('location'));
      if (
        response.status !== 302 ||
        location.protocol !== 'https:' ||
        location.username ||
        location.password ||
        location.port
      )
        throw new Error('Invalid artifact download redirect');
      // Signed storage redirect receives no GitHub headers or token.
      const zip = await request('GET', location.href, {
        timeoutMs: 15_000,
        maxBytes: 1_048_576,
        redirect: 'error',
      });
      if (zip.status !== 200 || `sha256:${sha256(zip.body)}` !== source.digest)
        throw new Error('GitHub artifact ZIP digest mismatch');
      const temp = mkdtempSync(join(tmpdir(), 'canary-zip-'));
      try {
        const archive = join(temp, 'archive.zip');
        writeFileSync(archive, zip.body, { flag: 'wx', mode: 0o600 });
        execFileSync(
          'python3',
          [
            fileURLToPath(new URL('./extract-canary.py', import.meta.url)),
            archive,
            directory,
            policy.canaryPrefix,
          ],
          { timeout: 10_000, stdio: 'pipe' },
        );
      } catch {
        throw new Error('Canary archive extraction failed');
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      // Recheck expiration/provenance after download; a removed artifact is not a recovery input.
      await metadata(artifactId, options);
      return source.metadata;
    },
  });
}
