/** Explicit, independently observable Blog switch changes; never rewrite routes or code. */
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import CloudBase from '@cloudbase/manager-node';
import { readArticleQueueStatus } from '../../packages/db/src/article-release-source.ts';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { createGithubReadClient } from '../release/github-read.mjs';
import { identity } from '../release/input.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { setBlogFunctionSwitch } from './publishing-switch.mjs';
import { readFunctionRuntimeState, readFunctionRuntimeVersion } from './runtime-health.mjs';
import { assertServerBlogReady } from './server-route-health.mjs';
import { blogWorkerSdk } from './worker-source.ts';
const env = process.env;
const policy = assertBlogBootstrapInvocation(env);
const action = env.BLOG_SERVER_SWITCH_ACTION;
if (
  !['initialize', 'publish', 'restore'].includes(action ?? '') ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !env.GITHUB_TOKEN
)
  throw Error('Explicit reviewed Blog switch action required');
const codeSha = env.GITHUB_SHA ?? '';
await createGithubReadClient({ policy, token: env.GITHUB_TOKEN }).requireCI(codeSha);
const manager = new CloudBase({
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const sdk = blogWorkerSdk({
  env: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const queue = await readArticleQueueStatus(sdk.database());
if (queue.hasQueued || queue.hasUnknown)
  throw Error('Existing article work must be resolved before changing switches');
for (const name of ['admin', 'public-api'])
  if ((await readFunctionRuntimeVersion(policy.envId, name)) !== codeSha)
    throw Error('Both actual APIs must run this reviewed source before changing switches');
if (action === 'publish') {
  const health = await assertServerBlogReady(policy.siteOrigin);
  if (health.releaseId !== codeSha)
    throw Error('The actual Blog domain must run this reviewed source before opening publishing');
  const current = await readFunctionRuntimeState(policy.envId, 'admin');
  if (current.articleDeliveryMode !== 'server')
    throw Error('Actual admin must confirm server publication mode before opening publishing');
}
const provider = createCloudbaseFunctionProvider({
  manager,
  target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
  region: policy.region,
  names: ['admin', 'public-api'],
  configurationKey: createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
    .update(`blog-server-flags:${policy.envId}`)
    .digest(),
});
const commands =
  action === 'initialize'
    ? [
        { name: 'admin', key: 'ARTICLE_PUBLISHING_ENABLED', value: '0' },
        { name: 'admin', key: 'ARTICLE_DELIVERY_MODE', value: 'server' },
        { name: 'public-api', key: 'ARTICLE_PUBLIC_READ_ENABLED', value: '1' },
      ]
    : [
        {
          name: 'admin',
          key: 'ARTICLE_PUBLISHING_ENABLED',
          value: action === 'publish' ? '1' : '0',
        },
      ];
await mkdir('output/blog-server-switch', { recursive: true });
const results: unknown[] = [];
for (const command of commands) {
  const { name, key, value } = command;
  const readAppliedValue = async () => {
    const current = await readFunctionRuntimeState(policy.envId, name);
    if (key === 'ARTICLE_DELIVERY_MODE') return current.articleDeliveryMode;
    const applied =
      name === 'admin' ? current.articlePublishingEnabled : current.articlePublicReadEnabled;
    return typeof applied === 'boolean' ? (applied ? '1' : '0') : undefined;
  };
  const result = await setBlogFunctionSwitch({
    manager,
    envId: policy.envId,
    expectedVersion: codeSha,
    name,
    key,
    value,
    readHealth: () => readFunctionRuntimeVersion(policy.envId, name),
    readPackageHash: async () => (await provider.inspect(name)).packageSha256,
    readAppliedValue,
    beforeChange: async () => {
      const before = await manager.functions.getFunctionDetail(name);
      const prior = before.Environment?.Variables?.find(
        (v: { Key: string }) => v.Key === key,
      )?.Value;
      await writeFile(
        `output/blog-server-switch/${name}-${key}.json`,
        JSON.stringify(
          { action, name, key, prior: prior ?? null, desired: value, codeSha },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    },
  });
  results.push({ name, key, value, result });
  await writeFile(
    'output/blog-server-switch/result.json',
    JSON.stringify({ action, codeSha, results }, null, 2),
  );
  if (result.status !== 'accepted')
    throw Error('Blog switch was not accepted; no further change will run');
}
console.log(
  'Only the requested Blog switches changed; program packages, routes and business records were not written.',
);
