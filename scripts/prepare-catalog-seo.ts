import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import { prepareCatalogResources } from './release/catalog-resource-setup.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
const env = process.env;
if (
  env.GITHUB_ACTIONS !== 'true' ||
  env.GITHUB_REF !== policy.trustedRef ||
  env.GITHUB_REPOSITORY !== policy.repository ||
  env.TCB_ENV_ID !== policy.envId ||
  !env.GITHUB_TOKEN ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
)
  throw Error('Untrusted catalog preparation invocation');
await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(env.GITHUB_SHA, {
  ref: env.GITHUB_REF,
  event: env.GITHUB_EVENT_NAME,
  runId: env.GITHUB_RUN_ID,
  workflowRef: env.GITHUB_WORKFLOW_REF,
});
const manager = new CloudBase({
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const directory = resolve('output/catalog-preparation');
await mkdir(directory, { recursive: true });
const result = await prepareCatalogResources(manager, async (progress) => {
  await writeFile(
    resolve(directory, 'receipt.json'),
    JSON.stringify({ codeSha: env.GITHUB_SHA, ...progress }, null, 2),
  );
});
await writeFile(
  resolve(directory, 'receipt.json'),
  JSON.stringify({ codeSha: env.GITHUB_SHA, ...result }, null, 2),
);
console.log(JSON.stringify(result));
