import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicBuildEnvironment } from '../release/public-build-env.mjs';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { siteArtifact } from '../release/site-payload.mjs';
import { assertCleanAcceptedSite, assertSiteDeliveryInvocation } from '../release/site-policy.mjs';
import { createReleaseCoordinator } from '../release/state.mjs';
import {
  createCloudbaseReleaseDatabase,
  createCloudbaseReleaseStore,
} from '../release/store-cloudbase.mjs';
const env = process.env;
const policy = assertSiteDeliveryInvocation(env);
if (
  env.GITHUB_REF !== 'refs/heads/test' ||
  env.SITE_DELIVERY_BUILT_INPUT !== '1' ||
  !env.GITHUB_TOKEN
)
  throw Error('Explicit normal test snapshot preparation required');
const source = env.SITE_PRODUCT_SOURCE ?? 'fresh';
const output = resolve('output/seo-release');
await mkdir(output, { recursive: true });
const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
await github.requireCI(env.GITHUB_SHA, {
  ref: env.GITHUB_REF,
  event: env.GITHUB_EVENT_NAME,
  runId: env.GITHUB_RUN_ID,
  workflowRef: env.GITHUB_WORKFLOW_REF,
});
if (!env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY)
  throw Error('Existing read-capable environment credentials required');
const db = createCloudbaseReleaseDatabase({
  env: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const coordinator = createReleaseCoordinator({
  store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
  policy,
});
const status = await coordinator.status({ scopeKey: 'site' });
assertCleanAcceptedSite(status);
async function command(args: string[]) {
  await new Promise<void>((done, reject) => {
    const child = spawn(resolve('apps/site/node_modules/.bin/tsx'), args, {
      env: publicBuildEnvironment(env),
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(Error('Public snapshot preparation stopped')),
    );
  });
}
let receipt: Record<string, unknown> = { source };
if (source === 'fresh')
  await command([
    'apps/site/scripts/prepare-product-seo.ts',
    resolve(output, 'product-snapshot.json'),
  ]);
else {
  const accepted = await coordinator.runStatus(status.scope.baseline.sourceRunId);
  assert.equal(accepted.state, 'SUCCEEDED');
  const artifact = accepted.composition.static.artifact;
  const directory = resolve(output, 'product-reuse-source');
  const run = await github.download(artifact.artifactId, directory, {
    acceptedRunId: artifact.runId,
  });
  const verified = siteArtifact({
    directory,
    policy,
    run,
    acceptedSeal: accepted.accepted.seals.static,
  });
  const paths = resolve(output, 'product-current-paths.json');
  await command(['apps/site/scripts/prepare-product-public-paths.ts', paths]);
  await command([
    'apps/site/scripts/reuse-product-seo.ts',
    resolve(verified.directory, 'product-snapshot.json'),
    paths,
    resolve(output, 'product-snapshot.json'),
  ]);
  receipt = { source, acceptedSiteRunId: accepted.runId, artifactId: artifact.artifactId };
}
await writeFile(resolve(output, 'product-source.json'), JSON.stringify(receipt, null, 2), {
  flag: 'wx',
});
console.log(`Prepared the complete public product input using explicit ${source} mode.`);
