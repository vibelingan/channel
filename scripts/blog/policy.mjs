export const BLOG_DUMMY_POLICY = Object.freeze({
  repository: 'vibelingan/channel',
  envId: 'diversity-123-d9grnqfux221323bb',
  siteOrigin: 'https://supplychainsai.com',
  region: 'ap-shanghai',
  canaryPrefix: '__blog-dummy/',
  workflowPath: '.github/workflows/seo-blog-dummy.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
  functionName: 'seo-blog-dummy',
});
export function assertBlogDummyInvocation(env) {
  const p = BLOG_DUMMY_POLICY;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REPOSITORY !== p.repository ||
    env.GITHUB_REF !== p.trustedRef ||
    env.GITHUB_JOB !== 'dummy' ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    env.TCB_ENV_ID !== p.envId ||
    env.SITE_URL !== p.siteOrigin ||
    env.CLOUDBASE_REGION !== p.region ||
    env.BLOG_DUMMY_CONFIRM !== 'ISOLATED_BLOG_ONLY'
  )
    throw new Error('Untrusted isolated Blog invocation');
  return p;
}
