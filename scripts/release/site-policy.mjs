export const SITE_DELIVERY_POLICY = Object.freeze({
  repository: 'vibelingan/channel',
  envId: 'diversity-123-d9grnqfux221323bb',
  region: 'ap-shanghai',
  canaryPrefix: '__release-canary/',
  controlPlaneReviewSha256: 'ade149d24c39b4b413db0a5c2ca5db422115d3c116046dd01c4895a23a87c515',
  siteOrigin: 'https://supplychainsai.com',
  trustedRef: 'refs/heads/feat/seo-foundation',
  workflowPath: '.github/workflows/seo-static-canary.yml',
});
export function assertSiteDeliveryInvocation(env) {
  const p = SITE_DELIVERY_POLICY;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REPOSITORY !== p.repository ||
    env.GITHUB_REF !== p.trustedRef ||
    env.TCB_ENV_ID !== p.envId ||
    env.SITE_URL !== p.siteOrigin ||
    env.CLOUDBASE_REGION !== p.region ||
    !['publish', 'restore'].includes(env.SITE_DELIVERY_MODE) ||
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
  return p;
}
