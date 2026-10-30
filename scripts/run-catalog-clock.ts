import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import { blogWorkerSdk } from './blog/worker-source.ts';
import { buildCatalogClock } from './catalog-clock-build.mjs';
import { deployCatalogClock } from './release/catalog-clock-deploy.mjs';
import { createCatalogGithubApp } from './release/catalog-github-app.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { assertCleanAcceptedSite, SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';
const env = process.env;
const action = env.CATALOG_CLOCK_ACTION;
if (
  env.GITHUB_ACTIONS !== 'true' ||
  env.GITHUB_REPOSITORY !== policy.repository ||
  env.GITHUB_REF !== policy.trustedRef ||
  env.TCB_ENV_ID !== policy.envId ||
  !env.GITHUB_TOKEN ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !['stage', 'enable', 'disable'].includes(action ?? '') ||
  !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
)
  throw Error('Untrusted clock deployment invocation');
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
const directory = resolve('output/catalog-clock');
await mkdir(directory, { recursive: true });
let accepted: { verified: boolean; rendererSha: string } | undefined;
let credentials: { appId: string; installationId: string; privateKey: string } | undefined;
if (action === 'enable') {
  if (
    !env.CATALOG_GITHUB_APP_ID ||
    !env.CATALOG_GITHUB_INSTALLATION_ID ||
    !env.CATALOG_GITHUB_PRIVATE_KEY
  )
    throw Error('Install the repository-only GitHub application first');
  credentials = {
    appId: env.CATALOG_GITHUB_APP_ID,
    installationId: env.CATALOG_GITHUB_INSTALLATION_ID,
    privateKey: env.CATALOG_GITHUB_PRIVATE_KEY,
  };
  const github = createCatalogGithubApp(credentials);
  await github.head('feat/seo-foundation');
  const db = blogWorkerSdk({
    env: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  }).database();
  const baseline = assertCleanAcceptedSite(
    await createReleaseCoordinator({
      store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
      policy,
    }).status({ scopeKey: 'site' }),
  );
  const response = await db.collection('catalogSeoBuilders').doc('active').get();
  const active = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!active || active.acceptedRunId !== baseline.sourceRunId)
    throw Error('Current HTML has no matching accepted renderer');
  accepted = { verified: true, rendererSha: active.codeSha };
}
if (action === 'stage') await buildCatalogClock(resolve(directory, 'function'), env.GITHUB_SHA);
const result = await deployCatalogClock({
  manager,
  action,
  directory: resolve(directory, 'function'),
  codeSha: env.GITHUB_SHA,
  credentials,
  accepted,
});
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(result, null, 2), {
  flag: 'wx',
});
console.log(JSON.stringify(result));
