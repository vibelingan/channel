export const BLOG_BOOTSTRAP_POLICY = Object.freeze({
  repository: 'vibelingan/channel',
  envId: 'diversity-123-d9grnqfux221323bb',
  siteOrigin: 'https://supplychainsai.com',
  region: 'ap-shanghai',
  trustedRef: 'refs/heads/feat/seo-foundation',
  workflowPath: '.github/workflows/seo-static-canary.yml',
  functionName: 'admin',
});
export function assertBlogBootstrapInvocation(env) {
  const p = BLOG_BOOTSTRAP_POLICY;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REPOSITORY !== p.repository ||
    env.GITHUB_REF !== p.trustedRef ||
    env.TCB_ENV_ID !== p.envId ||
    env.SITE_URL !== p.siteOrigin ||
    env.CLOUDBASE_REGION !== p.region ||
    env.BLOG_BOOTSTRAP_CONFIRM !== 'BLOG_API_EXPANSION_ONLY' ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
  )
    throw new Error('Untrusted Blog API preparation invocation');
  return p;
}
