export const SITE_DELIVERY_POLICY = Object.freeze({
  repository: 'vibelingan/channel',
  envId: 'diversity-123-d9grnqfux221323bb',
  region: 'ap-shanghai',
  canaryPrefix: '__release-canary/',
  controlPlaneReviewSha256: 'ade149d24c39b4b413db0a5c2ca5db422115d3c116046dd01c4895a23a87c515',
  siteOrigin: 'https://supplychainsai.com',
  trustedRef: 'refs/heads/feat/seo-foundation',
  workflowPath: '.github/workflows/seo-static-canary.yml',
  sources: [
    {
      workflowPath: '.github/workflows/seo-static-canary.yml',
      trustedRef: 'refs/heads/feat/seo-foundation',
      events: ['workflow_dispatch'],
    },
    {
      workflowPath: '.github/workflows/seo-static-canary.yml',
      trustedRef: 'refs/heads/test',
      events: ['workflow_dispatch'],
    },
    {
      workflowPath: '.github/workflows/deploy-test.yml',
      trustedRef: 'refs/heads/test',
      events: ['push', 'workflow_dispatch'],
    },
  ],
});
export function assertCleanAcceptedSite(status) {
  if (
    status?.state !== 'idle' ||
    status.pendingStep !== null ||
    !status.target ||
    ['lease', 'currentRunId', 'dirtyRunId', 'unresolvedOperation'].some(
      (field) => status.target[field] !== null,
    ) ||
    status.scope?.scopeKey !== 'site' ||
    !status.scope.baseline?.sourceRunId
  )
    throw Error('Finish the existing website delivery or restoration before normal deployment');
  return status.scope.baseline;
}
export function assertSiteDeliveryInvocation(env) {
  const p = SITE_DELIVERY_POLICY;
  const normal =
    env.GITHUB_REF === 'refs/heads/test' &&
    env.GITHUB_WORKFLOW_REF ===
      `${p.repository}/.github/workflows/deploy-test.yml@refs/heads/test` &&
    ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME);
  const content =
    ['refs/heads/feat/seo-foundation', 'refs/heads/test'].includes(env.GITHUB_REF) &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    ((!env.GITHUB_WORKFLOW_REF && env.GITHUB_REF === p.trustedRef) ||
      env.GITHUB_WORKFLOW_REF ===
        `${p.repository}/.github/workflows/seo-static-canary.yml@${env.GITHUB_REF}`);
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    (!normal && !content) ||
    env.GITHUB_REPOSITORY !== p.repository ||
    env.TCB_ENV_ID !== p.envId ||
    env.SITE_URL !== p.siteOrigin ||
    env.CLOUDBASE_REGION !== p.region ||
    !['initialize', 'publish', 'restore'].includes(env.SITE_DELIVERY_MODE) ||
    (env.SITE_DELIVERY_MODE === 'initialize' &&
      (env.GITHUB_REF !== p.trustedRef || env.SITE_ARTICLE_TASK_ID || env.SITE_RESTORE_RUN_ID)) ||
    (normal &&
      (env.SITE_DELIVERY_MODE !== 'publish' ||
        env.SITE_ARTICLE_TASK_ID ||
        env.SITE_DELIVERY_FAULT === 'after-upload')) ||
    normal !== (env.SITE_DELIVERY_BUILT_INPUT === '1') ||
    !['fresh', 'accepted'].includes(env.SITE_PRODUCT_SOURCE ?? 'fresh') ||
    !['none', 'after-upload'].includes(env.SITE_DELIVERY_FAULT ?? 'none') ||
    (env.SITE_DELIVERY_FAULT === 'after-upload' &&
      (env.SITE_DELIVERY_MODE !== 'publish' ||
        !/^release-[a-f0-9]{64}$/.test(env.SITE_ARTICLE_TASK_ID ?? ''))) ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    env.SITE_DELIVERY_CONFIRM !== 'FORMAL_SITE_ONLY'
  )
    throw Error('Untrusted formal site invocation');
  return env.GITHUB_REF === p.trustedRef
    ? p
    : Object.freeze({
        ...p,
        trustedRef: env.GITHUB_REF,
        workflowPath: normal ? '.github/workflows/deploy-test.yml' : p.workflowPath,
      });
}
