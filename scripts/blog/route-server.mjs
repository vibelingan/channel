import { mkdir, writeFile } from 'node:fs/promises';
import { DefaultArtifactClient } from '@actions/artifact';
import { createGithubReadClient } from '../release/github-read.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
import { readFunctionRuntimeState } from './runtime-health.mjs';
import { exposeBlogServer } from './server-exposure.mjs';
import { assertServerBlogReady } from './server-route-health.mjs';
import { setBlogRoutes } from './server-routes.mjs';
const env = process.env;
const policy = assertBlogBootstrapInvocation(env);
const action = env.BLOG_SERVER_ROUTE_ACTION;
if (!['initialize', 'publish', 'restore'].includes(action) || !env.GITHUB_TOKEN)
  throw Error('Reviewed Blog route action required');
const github = createGithubReadClient({ policy, token: env.GITHUB_TOKEN });
await github.requireCI(env.GITHUB_SHA);
const [admin, api] = await Promise.all([
  readFunctionRuntimeState(policy.envId, 'admin'),
  readFunctionRuntimeState(policy.envId, 'public-api'),
]);
if (
  admin.releaseId !== api.releaseId ||
  admin.articleDeliveryMode !== 'server' ||
  admin.articlePublishingEnabled !== false ||
  api.articlePublicReadEnabled !== true
)
  throw Error('Pause publication and verify both actual APIs before changing routes');
await github.requireCI(admin.releaseId);
const client = await connectBlogMcp();
const directory = 'output/blog-server-route';
await mkdir(directory, { recursive: true });
let count = 0;
try {
  const detail = await client.call('queryCloudRun', {
    action: 'detail',
    detailServerName: 'blog-pages',
  });
  const host = detail.data?.service?.BaseInfo?.DefaultDomainName;
  if (
    detail.data?.service?.BaseInfo?.ServerName !== 'blog-pages' ||
    typeof host !== 'string' ||
    !/^https:\/\/blog-pages-[a-z0-9-]+\.sh\.run\.tcloudbase\.com$/.test(host)
  )
    throw Error('The exact Blog service default domain is required');
  const response = await fetchFully('GET', `${host}/blog/health.json`, {
    redirect: 'error',
    timeoutMs: 30000,
    maxBytes: 32768,
  });
  const health = JSON.parse(response.body.toString());
  if (
    response.status !== 200 ||
    health.service !== 'blog-pages' ||
    health.siteOrigin !== policy.siteOrigin ||
    health.releaseId !== admin.releaseId
  )
    throw Error('Actual Blog service does not match the reviewed APIs');
  const save = async (record) => {
    const file = `${directory}/${String(count++).padStart(2, '0')}-${record.phase}.json`;
    await writeFile(
      file,
      JSON.stringify(
        { executorSha: env.GITHUB_SHA, deployedSha: admin.releaseId, ...record },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    if (record.phase === 'before') {
      const archived = await new DefaultArtifactClient().uploadArtifact(
        `blog-route-before-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
        [file],
        directory,
        { retentionDays: 90 },
      );
      if (!archived.id || !archived.digest)
        throw Error('Route recovery input was not archived; no route changed');
    }
  };
  if (action === 'publish') {
    const ready = await assertServerBlogReady(policy.siteOrigin);
    if (ready.releaseId !== admin.releaseId) throw Error('Actual Blog domain differs');
    await exposeBlogServer({
      client,
      save,
      readHealth: async () => {
        const response = await fetchFully('GET', `${host}/blog/health.json`, {
          redirect: 'error',
          timeoutMs: 15000,
          maxBytes: 32768,
        });
        const value = JSON.parse(response.body.toString());
        if (
          response.status !== 200 ||
          value.service !== 'blog-pages' ||
          value.siteOrigin !== policy.siteOrigin
        )
          throw Error('Blog health not confirmed');
        return value;
      },
      verify: async () => {
        const actual = await assertServerBlogReady(policy.siteOrigin);
        const page = await fetchFully('GET', `${policy.siteOrigin}/blog/`, { redirect: 'error' });
        if (
          actual.previewOnly ||
          actual.releaseId !== admin.releaseId ||
          page.headers.get('x-robots-tag')?.includes('noindex')
        )
          throw Error('The actual domain is still in staging mode');
      },
    });
  } else
    await setBlogRoutes({
      client,
      action,
      save,
      verify: async () => {
        if (action === 'initialize') {
          const actual = await assertServerBlogReady(policy.siteOrigin);
          if (actual.releaseId !== admin.releaseId)
            throw Error('Actual Blog domain uses a different service version');
          const missing = await fetchFully(
            'GET',
            `${policy.siteOrigin}/blog/route-acceptance-missing-${env.GITHUB_RUN_ID}/`,
            { redirect: 'error' },
          );
          if (missing.status !== 404) throw Error('Missing Blog must return the actual 404 status');
        } else {
          const fallback = await fetchFully('GET', `${policy.siteOrigin}/blog/`, {
            redirect: 'error',
          });
          if (fallback.headers.get('x-channel-blog-version'))
            throw Error('Blog route still reaches Node after disabling it');
        }
      },
    });
} finally {
  await client.close();
}
