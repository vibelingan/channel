import assert from 'node:assert/strict';
import test from 'node:test';
import { policy as base } from './release-state-fixtures.mjs';
import {
  createGithubSource,
  validateArtifactSource,
  validateInvocation,
} from './release/github-source.mjs';
const policy = {
  ...base,
  workflowPath: '.github/workflows/seo-static-canary.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
};
const now = Date.parse('2026-10-21T00:00:00Z');
const artifact = {
  id: 11,
  name: 'static-canary-payload-101-1',
  expired: false,
  expires_at: '2027-01-01T00:00:00Z',
  size_in_bytes: 1024,
  digest: `sha256:${'a'.repeat(64)}`,
  workflow_run: {
    id: 101,
    repository_id: 7,
    head_repository_id: 7,
    head_sha: 'b'.repeat(40),
    head_branch: 'feat/seo-foundation',
  },
};
const run = {
  id: 101,
  run_attempt: 1,
  path: policy.workflowPath,
  event: 'workflow_dispatch',
  head_branch: 'feat/seo-foundation',
  head_sha: 'b'.repeat(40),
  status: 'completed',
  conclusion: 'success',
  repository: { id: 7, full_name: policy.repository },
  head_repository: { id: 7, full_name: policy.repository },
};
test('artifact metadata authenticates exact manual producer and completed source', () => {
  const metadata = validateArtifactSource({ artifact, run, policy, now });
  assert.equal(metadata.artifact.id, '11');
  for (const mutation of [
    { expired: true },
    { digest: null },
    { id: 'bad' },
    { workflow_run: { ...artifact.workflow_run, head_repository_id: 9 } },
    { name: 'other' },
  ])
    assert.throws(() =>
      validateArtifactSource({ artifact: { ...artifact, ...mutation }, run, policy, now }),
    );
  for (const mutation of [
    { event: 'pull_request' },
    { conclusion: 'failure' },
    { head_sha: 'c'.repeat(40) },
    { path: '.github/workflows/other.yml' },
    { head_branch: 'main' },
    { repository: { id: 7, full_name: 'other/repo' } },
  ])
    assert.throws(() =>
      validateArtifactSource({ artifact, run: { ...run, ...mutation }, policy, now }),
    );
  assert.throws(() =>
    validateArtifactSource({
      artifact,
      run: { ...run, status: 'in_progress', conclusion: null },
      policy,
      now,
    }),
  );
  assert.equal(
    validateArtifactSource({
      artifact,
      run: { ...run, status: 'in_progress', conclusion: null },
      policy,
      now,
      allowCurrentRunId: '101',
    }).runId,
    '101',
  );
});
test('entrypoint refuses local, wrong repository/ref, rerun without explicit identity and automatic invocation', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: policy.repository,
    GITHUB_REF: policy.trustedRef,
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '101',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'canary',
  };
  assert.equal(validateInvocation(env, policy).ownerRunId, 'github-101-1');
  for (const mutation of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_JOB: 'other' },
  ])
    assert.throws(() => validateInvocation({ ...env, ...mutation }, policy));
});
test('GitHub API credential is never sent to a redirected storage host', async () => {
  const calls = [];
  const client = createGithubSource({
    policy,
    token: 'fake-secret',
    request: async (_method, url, opts) => {
      calls.push({ url, opts });
      return {
        status: 302,
        headers: new Headers({ location: 'https://storage.example/archive' }),
        body: Buffer.from(''),
      };
    },
  });
  await assert.rejects(client.api('/actions/artifacts/11'), /GitHub API/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.redirect, 'error');
});

test('exact executor CI is mandatory and cannot be satisfied by a different SHA or PR workflow', async () => {
  const codeSha = 'b'.repeat(40);
  let runs = [];
  const client = createGithubSource({
    policy,
    token: 'fake',
    request: async () => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ workflow_runs: runs })),
    }),
  });
  await assert.rejects(client.requireCI(codeSha), /no successful offline CI/);
  runs = [{ ...run, path: '.github/workflows/seo-module-1.yml', event: 'pull_request' }];
  await assert.rejects(client.requireCI(codeSha));
  runs = [{ ...runs[0], event: 'push', head_sha: 'c'.repeat(40) }];
  await assert.rejects(client.requireCI(codeSha));
  runs = [{ ...runs[0], head_sha: codeSha }];
  await client.requireCI(codeSha);
});

test('artifact download rejects a mismatched ZIP digest before extraction and strips API credentials', async () => {
  const calls = [];
  const client = createGithubSource({
    policy,
    token: 'fake-secret',
    request: async (_method, url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith('/zip'))
        return {
          status: 302,
          headers: new Headers({ location: 'https://storage.example/signed.zip' }),
        };
      if (url.startsWith('https://storage.example'))
        return { status: 200, body: Buffer.from('corrupt zip') };
      return {
        status: 200,
        body: Buffer.from(JSON.stringify(url.endsWith('/artifacts/11') ? artifact : run)),
      };
    },
  });
  await assert.rejects(client.download('11', '/must-not-create', { now }), /digest mismatch/);
  const storage = calls.find((c) => c.url.startsWith('https://storage.example'));
  assert.equal(storage.opts.headers, undefined);
  assert.equal(storage.opts.redirect, 'error');
});

test('source metadata pins the original attempt so rerunning a workflow does not erase accepted provenance', async () => {
  const calls = [];
  const client = createGithubSource({
    policy,
    token: 'fake',
    request: async (_method, url) => {
      calls.push(url);
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify(
            url.endsWith('/artifacts/11')
              ? artifact
              : url.endsWith('/attempts/1')
                ? run
                : { ...run, run_attempt: 2, status: 'in_progress', conclusion: null },
          ),
        ),
      };
    },
  });
  assert.equal((await client.metadata('11', { now })).metadata.runId, '101');
  assert.ok(calls.some((url) => url.endsWith('/runs/101/attempts/1')));
});
