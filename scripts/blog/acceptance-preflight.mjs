import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { readFunctionRuntimeState } from './runtime-health.mjs';
import { assertServerBlogReady } from './server-route-health.mjs';
const env = process.env;
const policy = assertBlogBootstrapInvocation(env);
if (![undefined, 'static', 'server'].includes(env.E2E_BLOG_DELIVERY_MODE))
  throw Error('Explicit supported Blog delivery mode required');
if (
  !['create', 'retry', 'update', 'withdraw', 'check'].includes(
    env.E2E_BLOG_PUBLICATION_OPERATION,
  ) ||
  !env.GITHUB_TOKEN
)
  throw Error('Explicit article acceptance required');
if (
  (env.E2E_BLOG_PUBLICATION_OPERATION === 'create' && env.E2E_BLOG_ARTICLE_ID) ||
  (env.E2E_BLOG_PUBLICATION_OPERATION !== 'create' &&
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(env.E2E_BLOG_ARTICLE_ID ?? ''))
)
  throw Error('Explicit owned article required');
await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(env.GITHUB_SHA);
if (env.E2E_BLOG_DELIVERY_MODE === 'server') {
  if (env.E2E_BLOG_PUBLICATION_OPERATION === 'retry')
    throw Error('Server publication does not retry a legacy build');
  const health = await assertServerBlogReady(policy.siteOrigin);
  await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(health.releaseId);
  const [admin, api] = await Promise.all([
    readFunctionRuntimeState(policy.envId, 'admin'),
    readFunctionRuntimeState(policy.envId, 'public-api'),
  ]);
  if (
    admin.releaseId !== health.releaseId ||
    api.releaseId !== health.releaseId ||
    admin.articleDeliveryMode !== 'server' ||
    admin.articlePublishingEnabled !== true ||
    api.articlePublicReadEnabled !== true
  )
    throw Error('Actual Blog service and both APIs must be ready before browser writes');
}
console.log('Exact offline CI and the real-site acceptance target confirmed.');
