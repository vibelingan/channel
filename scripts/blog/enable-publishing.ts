import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { auditHostingContract } from '../hosting-contract.mjs';
import { assertAcceptedHostingFiles } from '../hosting-delta.mjs';
import { createCanaryProvider } from '../release/canary-provider.mjs';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { identity } from '../release/input.mjs';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { siteArtifact } from '../release/site-payload.mjs';
import { SITE_DELIVERY_POLICY as policy } from '../release/site-policy.mjs';
import { createReleaseCoordinator } from '../release/state.mjs';
import {
  createCloudbaseReleaseDatabase,
  createCloudbaseReleaseStore,
} from '../release/store-cloudbase.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { setArticlePublishing } from './publishing-switch.mjs';
import { readArticleQueueProbe } from './queue-probe.mjs';
import { readAdminRuntimeVersion } from './runtime-health.mjs';
assertBlogBootstrapInvocation(process.env);
const env = process.env;
if (
  env.BLOG_ENABLE_CONFIRM !== 'ENABLE_AFTER_ACCEPTED_SITE' ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !env.GITHUB_TOKEN
)
  throw Error('Explicit post-delivery activation and existing credentials required');
const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
await github.requireCI(env.GITHUB_SHA);
const manager = new CloudBase({
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const hosting = createCanaryProvider({ manager, policy });
await hosting.controlPlane({ execute: true });
const target = { envId: policy.envId, siteOrigin: policy.siteOrigin };
const configurationKey = createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
  .update(`channel-function-observation:v1:${identity(target)}`)
  .digest();
const functions = createCloudbaseFunctionProvider({
  manager,
  target,
  region: policy.region,
  names: ['admin'],
  configurationKey,
});
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
const owner = `article-enable-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
const guard = await coordinator.acquire({
  ownerRunId: owner,
  runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:enable`,
});
let safeToRelease = true;
let renewing = false;
let lost = false;
const timer = setInterval(async () => {
  if (renewing) return;
  renewing = true;
  try {
    await coordinator.renew(guard);
  } catch {
    lost = true;
  } finally {
    renewing = false;
  }
}, 30000);
try {
  const status = await coordinator.status({ scopeKey: 'site' });
  if (
    status.pendingStep ||
    status.target.currentRunId ||
    status.target.dirtyRunId ||
    !status.scope.baseline
  )
    throw Error('An accepted formal site is required before enabling publication');
  const accepted = await coordinator.runStatus(status.scope.baseline.sourceRunId);
  const artifact = accepted.composition.static.artifact;
  const output = resolve('output/blog-bootstrap');
  await mkdir(output, { recursive: true });
  const directory = join(output, 'accepted-site');
  const source = await github.download(artifact.artifactId, directory, {
    acceptedRunId: artifact.runId,
  });
  const site = siteArtifact({
    directory,
    policy,
    run: source,
    acceptedSeal: accepted.accepted.seals.static,
  });
  assert(
    site.staticManifest.entries.some((e: { path: string }) => e.path === 'blog/index.html'),
    'The accepted site does not contain the public Blog',
  );
  assertAcceptedHostingFiles({ source: site, inventory: await hosting.readInventory() });
  const audit = await auditHostingContract(policy.siteOrigin);
  if (!audit.passed) throw Error('Website status/cache check failed; publication remains disabled');
  const intent = join(output, 'publishing-intent.json');
  await writeFile(
    intent,
    JSON.stringify(
      {
        codeSha: env.GITHUB_SHA,
        key: 'ARTICLE_PUBLISHING_ENABLED',
        desired: '1',
        acceptedSiteRunId: accepted.runId,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  const archived = await new DefaultArtifactClient().uploadArtifact(
    `blog-enable-intent-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    [intent],
    output,
    { retentionDays: 90 },
  );
  if (!archived.id || !archived.digest) throw Error('Activation intent not archived');
  if (lost) throw Error('Publication activation lost its shared lease');
  await readArticleQueueProbe({ key: env.BLOG_QUEUE_STATUS_KEY });
  const result = await setArticlePublishing({
    manager,
    envId: policy.envId,
    expectedVersion: env.GITHUB_SHA,
    readHealth: () => readAdminRuntimeVersion(policy.envId),
    readEnabled: async () =>
      (await readArticleQueueProbe({ key: env.BLOG_QUEUE_STATUS_KEY })).enabled,
    readPackageHash: async () => (await functions.inspect('admin')).packageSha256,
    beforeChange: async () => {
      if (lost) throw Error('Publication activation lost its shared lease');
      safeToRelease = false;
    },
  });
  safeToRelease = ['accepted', 'restored', 'not-written'].includes(result.status);
  await writeFile(join(output, 'publishing-result.json'), JSON.stringify(result, null, 2), {
    flag: 'wx',
  });
  if (result.status !== 'accepted')
    throw Error(`Article publishing switch ${result.status}; no further writes`);
  console.log(
    'The existing admin can now queue article publication; website, pricing, sync and all other admin settings unchanged.',
  );
} finally {
  clearInterval(timer);
  if (safeToRelease) await coordinator.release(guard);
}
