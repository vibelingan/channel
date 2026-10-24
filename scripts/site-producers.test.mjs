import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBlogArtifactSource } from './blog/github-source.mjs';
import { NORMAL_READY_JOB, requireSiteChecks } from './release/site-checks.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { siteProducerPolicy } from './release/site-producers.mjs';
const sha = 'a'.repeat(40);
const repository = { id: 7, full_name: policy.repository };
const normal = {
  id: 123,
  run_attempt: 1,
  path: '.github/workflows/deploy-test.yml',
  head_branch: 'test',
  event: 'push',
  head_sha: sha,
  repository,
  head_repository: repository,
  status: 'in_progress',
};
const context = {
  ref: 'refs/heads/test',
  event: 'push',
  runId: '123',
  workflowRef: `${policy.repository}/.github/workflows/deploy-test.yml@refs/heads/test`,
};
test('site recovery authenticates both reviewed producer paths without allowing other branches or pull requests', () => {
  for (const run of [
    normal,
    { ...normal, path: policy.workflowPath, event: 'workflow_dispatch' },
    {
      ...normal,
      path: policy.workflowPath,
      head_branch: 'feat/seo-foundation',
      event: 'workflow_dispatch',
    },
  ]) {
    const p = siteProducerPolicy(policy, run);
    const artifact = {
      id: 44,
      name: 'site-payload-123-1',
      expired: false,
      expires_at: '2099-01-01T00:00:00Z',
      size_in_bytes: 123,
      digest: `sha256:${'a'.repeat(64)}`,
      workflow_run: {
        id: 123,
        repository_id: 7,
        head_repository_id: 7,
        head_sha: sha,
        head_branch: run.head_branch,
      },
    };
    assert.equal(
      validateBlogArtifactSource(artifact, run, {
        sourcePolicy: p,
        artifactPrefix: 'site-payload',
        currentRunId: '123',
      }).headSha,
      sha,
    );
    assert.throws(() =>
      validateBlogArtifactSource(
        { ...artifact, workflow_run: { ...artifact.workflow_run, repository_id: 8 } },
        run,
        { sourcePolicy: p, artifactPrefix: 'site-payload', currentRunId: '123' },
      ),
    );
  }
  for (const delta of [
    { head_branch: 'main' },
    { event: 'pull_request' },
    { path: '.github/workflows/other.yml' },
  ])
    assert.throws(() => siteProducerPolicy(policy, { ...normal, ...delta }));
});
test('same-run checks allow normal deployment only after its real complete mandatory graph', async () => {
  async function verify({
    run = normal,
    jobs = [{ name: NORMAL_READY_JOB, status: 'completed', conclusion: 'success' }],
    ctx = context,
  } = {}) {
    return requireSiteChecks({
      policy,
      codeSha: sha,
      context: ctx,
      github: {
        requireCI: () => {
          throw Error('Wrong source gate');
        },
        api: async (path) => (path.includes('/jobs?') ? { jobs, total_count: jobs.length } : run),
      },
    });
  }
  await verify();
  for (const run of [
    { ...normal, head_sha: 'b'.repeat(40) },
    { ...normal, head_branch: 'main' },
    { ...normal, event: 'pull_request' },
    { ...normal, head_repository: { id: 8, full_name: policy.repository } },
    { ...normal, status: 'completed' },
  ])
    await assert.rejects(verify({ run }));
  for (const jobs of [
    [],
    [{ name: NORMAL_READY_JOB, status: 'in_progress', conclusion: null }],
    [{ name: NORMAL_READY_JOB, status: 'completed', conclusion: 'failure' }],
    [{ name: 'pretend green', status: 'completed', conclusion: 'success' }],
    Array(2).fill({ name: NORMAL_READY_JOB, status: 'completed', conclusion: 'success' }),
  ])
    await assert.rejects(verify({ jobs }));
});
test('automatic test content executor requires a completed successful same-SHA normal deployment', async () => {
  const ctx = {
    ...context,
    event: 'workflow_dispatch',
    workflowRef: `${policy.repository}/${policy.workflowPath}@refs/heads/test`,
  };
  for (const conclusion of ['success', 'failure']) {
    const promise = requireSiteChecks({
      policy,
      codeSha: sha,
      context: ctx,
      github: {
        api: async () => ({ workflow_runs: [{ ...normal, status: 'completed', conclusion }] }),
      },
    });
    if (conclusion === 'success') await promise;
    else await assert.rejects(promise);
  }
});
