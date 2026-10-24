import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubReadClient } from '../release/github-read.mjs';
import { sha256 } from '../release/input.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';
export function validateBlogArtifactSource(
  artifact,
  run,
  {
    currentRunId,
    acceptedRunId,
    now = Date.now(),
    sourcePolicy = policy,
    artifactPrefix = 'blog-dummy-payload',
    maxArchiveBytes = 72 * 1024 * 1024,
  } = {},
) {
  const id = (value) =>
    /^[1-9][0-9]*$/.test(String(value)) &&
    (typeof value !== 'number' || Number.isSafeInteger(value));
  if (
    !id(artifact.id) ||
    !id(run.id) ||
    !id(run.run_attempt) ||
    artifact.expired !== false ||
    Date.parse(artifact.expires_at) <= now ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    !Number.isSafeInteger(run.repository?.id) ||
    run.repository.id < 1 ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > maxArchiveBytes ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
    artifact.name !== `${artifactPrefix}-${run.id}-${run.run_attempt}` ||
    run.path !== sourcePolicy.workflowPath ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== sourcePolicy.trustedRef.slice(11) ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    run.repository?.full_name !== sourcePolicy.repository ||
    run.head_repository?.full_name !== sourcePolicy.repository ||
    run.repository.id !== run.head_repository.id ||
    artifact.workflow_run?.repository_id !== run.repository.id ||
    artifact.workflow_run?.head_repository_id !== run.repository.id ||
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    artifact.workflow_run?.head_branch !== run.head_branch ||
    !(
      (String(run.id) === currentRunId && run.status === 'in_progress') ||
      (run.status === 'completed' &&
        (run.conclusion === 'success' || String(run.id) === acceptedRunId))
    )
  )
    throw new Error('Untrusted Blog artifact source');
  return {
    repository: sourcePolicy.repository,
    workflowPath: sourcePolicy.workflowPath,
    event: run.event,
    ref: sourcePolicy.trustedRef,
    headSha: run.head_sha,
    runId: String(run.id),
    artifact: {
      id: String(artifact.id),
      runId: String(run.id),
      expired: false,
      expiresAt: artifact.expires_at,
    },
  };
}
export function createBlogGithubSource({
  token,
  request = fetchFully,
  sourcePolicy = policy,
  artifactPrefix = 'blog-dummy-payload',
  maxArchiveBytes = 72 * 1024 * 1024,
  extractor = new URL('./extract-payload.py', import.meta.url),
}) {
  if (
    !/^[a-z0-9-]+$/.test(artifactPrefix) ||
    !Number.isSafeInteger(maxArchiveBytes) ||
    maxArchiveBytes < 1 ||
    maxArchiveBytes > 512 * 1024 * 1024
  )
    throw Error('Invalid artifact download policy');
  const github = createGithubReadClient({ policy: sourcePolicy, token, request });
  async function metadata(id, options) {
    if (!/^[1-9][0-9]*$/.test(String(id))) throw new Error('Exact artifact ID required');
    const artifact = await github.api(`/actions/artifacts/${id}`);
    if (String(artifact.id) !== String(id)) throw new Error('Artifact identity mismatch');
    const match = new RegExp(`^${artifactPrefix}-([1-9][0-9]*)-([1-9][0-9]*)$`).exec(artifact.name);
    if (!match) throw new Error('Invalid Blog artifact name');
    const run = await github.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
    return {
      run: validateBlogArtifactSource(artifact, run, {
        ...options,
        sourcePolicy,
        artifactPrefix,
        maxArchiveBytes,
      }),
      digest: artifact.digest,
    };
  }
  return {
    requireCI: github.requireCI,
    async download(id, directory, options = {}) {
      const source = await metadata(id, options);
      const response = await github.get(`/actions/artifacts/${id}/zip`, { redirect: 'manual' });
      const location = new URL(response.headers.get('location'));
      if (
        response.status !== 302 ||
        location.protocol !== 'https:' ||
        location.username ||
        location.password ||
        location.port
      )
        throw new Error('Invalid Blog archive redirect');
      const body = await request('GET', location.href, {
        timeoutMs: 30000,
        maxBytes: maxArchiveBytes,
        redirect: 'error',
      });
      if (body.status !== 200 || `sha256:${sha256(body.body)}` !== source.digest)
        throw new Error('Blog archive digest mismatch');
      const temp = mkdtempSync(join(tmpdir(), 'blog-archive-'));
      try {
        const archive = join(temp, 'payload.zip');
        writeFileSync(archive, body.body, { mode: 0o600, flag: 'wx' });
        execFileSync('python3', [fileURLToPath(extractor), archive, directory], {
          timeout: 15000,
          stdio: 'pipe',
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      await metadata(id, options);
      return source.run;
    },
  };
}
