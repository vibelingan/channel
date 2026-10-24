import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
const env = process.env;
assertBlogBootstrapInvocation(env);
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
console.log('Exact offline CI and the real-site acceptance target confirmed.');
