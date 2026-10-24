const normalPath = '.github/workflows/deploy-test.yml';
export const NORMAL_READY_JOB = 'Verified source and browser checks / Required release checks';
function sameRepository(run, repository) {
  return (
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository &&
    Number.isSafeInteger(run.repository.id) &&
    run.repository.id > 0 &&
    run.repository.id === run.head_repository.id
  );
}
/** A normal deploy may continue only after its same-run mandatory check graph has completed. */
export async function requireSiteChecks({ github, policy, codeSha, context }) {
  if (!context || context.ref === policy.trustedRef) return github.requireCI(codeSha);
  if (!/^[a-f0-9]{40}$/.test(codeSha) || context.ref !== 'refs/heads/test')
    throw Error('Unapproved site executor');
  if (context.workflowRef === `${policy.repository}/${normalPath}@refs/heads/test`) {
    if (!/^\d+$/.test(context.runId ?? '')) throw Error('Exact normal deployment run required');
    const run = await github.api(`/actions/runs/${context.runId}`);
    if (
      run.path !== normalPath ||
      run.head_branch !== 'test' ||
      run.head_sha !== codeSha ||
      !sameRepository(run, policy.repository) ||
      run.status !== 'in_progress' ||
      !['push', 'workflow_dispatch'].includes(run.event) ||
      run.event !== context.event
    )
      throw Error('Normal deployment source differs');
    const jobs = [];
    for (let page = 1; page <= 10; page++) {
      const result = await github.api(
        `/actions/runs/${context.runId}/jobs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count))
        throw Error('Incomplete normal check graph');
      jobs.push(...result.jobs);
      if (jobs.length === result.total_count) break;
      if (jobs.length > result.total_count || result.jobs.length !== 100 || page === 10)
        throw Error('Incomplete normal check graph');
    }
    const marker = jobs.filter((job) => job.name === NORMAL_READY_JOB);
    if (
      marker.length !== 1 ||
      marker[0].status !== 'completed' ||
      marker[0].conclusion !== 'success'
    )
      throw Error('Required normal release checks have not passed');
    return;
  }
  if (
    context.workflowRef !==
      `${policy.repository}/.github/workflows/seo-static-canary.yml@refs/heads/test` ||
    context.event !== 'workflow_dispatch'
  )
    throw Error('Unapproved content executor');
  const result = await github.api(
    `/actions/workflows/deploy-test.yml/runs?head_sha=${codeSha}&status=completed&per_page=100`,
  );
  if (
    !result.workflow_runs?.some(
      (run) =>
        run.head_sha === codeSha &&
        run.path === normalPath &&
        run.head_branch === 'test' &&
        ['push', 'workflow_dispatch'].includes(run.event) &&
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        sameRepository(run, policy.repository),
    )
  )
    throw Error('The test executor has no completed successful deployment');
}
