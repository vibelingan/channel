import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import {
  articleIntegrationSchema,
  managedArticlePolicySchema,
} from '../../packages/articles/src/import-credentials.ts';
import { articleTransaction } from '../../packages/db/src/article-repository.ts';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { FORMAL_BLOG as p } from './formal-policy.mjs';
import { blogWorkerSdk } from './worker-source.ts';

const env = process.env;
assertBlogBootstrapInvocation(env);
assert(env.GITHUB_TOKEN && env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY);
await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(env.GITHUB_SHA);
const root = 'output/blog-images-preparation';
await mkdir(root, { recursive: true });
const manager = new CloudBase({
  envId: p.envId,
  region: p.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const provider = createCloudbaseFunctionProvider({
  manager,
  target: { envId: p.envId, siteOrigin: p.siteOrigin },
  region: p.region,
  names: [p.functionName],
  configurationKey: undefined,
});
const before = await provider.capture(p.functionName);
const manifest = JSON.parse(await readFile('output/article-import-package/manifest.json', 'utf8'));
const bytes = await readFile('output/article-import-package/function.zip');
assert.equal(manifest.codeSha, env.GITHUB_SHA);
assert.equal(manifest.envId, p.envId);
assert.equal(manifest.functionName, p.functionName);
assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
assert.equal(before.snapshot.runtime, 'Nodejs20.19');
assert.equal(before.snapshot.handler, 'index.main');
assert.equal(before.snapshot.role, 'TCB_QcsRole');
assert.equal(before.snapshot.triggerCount, 0);
assert.equal(before.snapshot.installDependency, 'FALSE');
assert(
  ['96fed50cf9e3ad0d4f1256fabdc64112eaad8bdc92fc8afbb31dab9361570ac8', manifest.sha256].includes(
    before.snapshot.packageSha256,
  ),
  'Importer differs from the observed formal program',
);
const transaction = articleTransaction(
  blogWorkerSdk({
    env: p.envId,
    region: p.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  }).database(),
);
const access = {
  _id: `media-access-${p.keyId}`,
  siteId: 'supplychainsai.com',
  keyId: p.keyId,
  integrationId: p.integrationId,
  enabled: true,
};
const credentials = await transaction(async (store) => ({
  key: await store.read('articleIntegrations', p.keyId),
  policy: await store.read('articleIntegrations', `managed-${p.keyId}`),
  access: await store.read('articleIntegrations', access._id),
}));
const key = articleIntegrationSchema.parse(credentials.key);
const policy = managedArticlePolicySchema.parse(credentials.policy);
assert.equal(key._id, p.keyId);
assert.equal(key.integrationId, p.integrationId);
assert(key.enabled && Date.parse(key.expiresAt) > Date.now());
assert.equal(policy.keyId, p.keyId);
assert.equal(policy.integrationId, p.integrationId);
if (credentials.access !== null)
  assert.deepEqual(
    credentials.access,
    access,
    'Existing image permission differs; do not silently reenable it',
  );
async function health() {
  const r = await fetchFully('GET', `${p.apiOrigin}/api/integrations/v1/article-drafts/health`, {
    timeoutMs: 15000,
    maxBytes: 32768,
    redirect: 'error',
  });
  assert.equal(r.status, 200);
  return JSON.parse(r.body.toString()).data;
}
const oldHealth = await health();
await writeFile(`${root}/before.zip`, before.bytes, { flag: 'wx' });
await writeFile(`${root}/candidate.zip`, bytes, { flag: 'wx' });
await writeFile(
  `${root}/scope.json`,
  JSON.stringify(
    {
      target: p.envId,
      source: env.GITHUB_SHA,
      functionName: p.functionName,
      before: before.snapshot,
      beforeHealth: oldHealth,
      candidate: manifest,
      collection: 'articleImportImageJobs',
      permission: 'ADMINONLY',
      accessPolicy: access,
      credentialsReplaced: false,
      articlesWritten: 0,
      recovery:
        'Restore only article-import code; disable image capability if needed; preserve credentials, articles, media and customer edits.',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
const archive = await new DefaultArtifactClient().uploadArtifact(
  `blog-images-before-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  [`${root}/before.zip`, `${root}/candidate.zip`, `${root}/scope.json`],
  root,
  { retentionDays: 90 },
);
assert(archive.id && archive.digest);
const result: Record<string, unknown> = {
  source: env.GITHUB_SHA,
  stage: 'backup-confirmed',
  archiveId: archive.id,
  otherFunctionsWritten: false,
  routesWritten: false,
  articlesWritten: 0,
  credentialsWritten: false,
};
const save = () => writeFile(`${root}/result.json`, JSON.stringify(result, null, 2));
async function waitPackage(hash: string) {
  const end = Date.now() + 120000;
  for (;;) {
    const current = await provider.inspect(p.functionName);
    if (
      current.status === 'Active' &&
      current.availableStatus === 'Available' &&
      current.packageSha256 === hash
    )
      return current;
    if (Date.now() >= end) throw Error('Importer activation unconfirmed');
    await new Promise((r) => setTimeout(r, 2000));
  }
}
try {
  result.stage = 'prepare-image-job-collection';
  await save();
  const name = 'articleImportImageJobs';
  try {
    await manager.database.describeCollection(name);
  } catch (e) {
    if (!(e instanceof Error) || Reflect.get(e, 'code') !== 'ResourceNotFound') throw e;
    await manager.database.createCollection(name);
    await manager.database.describeCollection(name);
  }
  const permission = async () => {
    const v = await manager.permission.describeResourcePermission({
      resourceType: 'collection',
      resources: [name],
    });
    assert.equal(v.Data?.TotalCount, 1);
    assert.equal(v.Data.PermissionList?.length, 1);
    const entry = v.Data.PermissionList[0];
    assert(entry);
    assert.equal(entry.Resource, name);
    return entry.Permission;
  };
  if ((await permission()) !== 'ADMINONLY')
    await manager.permission.modifyResourcePermission({
      resourceType: 'collection',
      resource: name,
      permission: 'ADMINONLY',
    });
  assert.equal(await permission(), 'ADMINONLY');
  result.stage = 'update-importer-code';
  await save();
  if (before.snapshot.packageSha256 !== manifest.sha256)
    await provider.updateCode({
      name: p.functionName,
      runtime: before.snapshot.runtime,
      handler: before.snapshot.handler,
      bytes,
      sha256: manifest.sha256,
      expectedSnapshot: before.snapshot,
    });
  const current = await waitPackage(manifest.sha256);
  assert.equal(current.configurationToken, before.snapshot.configurationToken);
  assert.equal(current.functionId, before.snapshot.functionId);
  assert.equal((await health()).releaseId, env.GITHUB_SHA);
  const denied = await fetchFully(
    'GET',
    `${p.apiOrigin}/api/integrations/v1/article-drafts/article-import-${'0'.repeat(64)}/images/state`,
    { timeoutMs: 15000, maxBytes: 32768, redirect: 'error' },
  );
  assert.equal(denied.status, 401);
  result.stage = 'enable-existing-publisher-images';
  await save();
  await transaction(async (store) => {
    const old = await store.read('articleIntegrations', access._id);
    if (old !== null) {
      assert.deepEqual(old, access);
      return;
    }
    const currentKey = articleIntegrationSchema.parse(
      await store.read('articleIntegrations', p.keyId),
    );
    assert(
      currentKey.enabled &&
        currentKey.integrationId === p.integrationId &&
        Date.parse(currentKey.expiresAt) > Date.now(),
    );
    const { _id, ...body } = access;
    await store.write('articleIntegrations', _id, body);
  });
  const actual = await transaction(async (store) => ({
    key: await store.read('articleIntegrations', p.keyId),
    policy: await store.read('articleIntegrations', policy._id),
    access: await store.read('articleIntegrations', access._id),
  }));
  // Credential maintenance may legitimately rotate while this code-only deployment runs. Never replace its rows.
  assert.equal(articleIntegrationSchema.parse(actual.key)._id, p.keyId);
  assert.equal(managedArticlePolicySchema.parse(actual.policy).keyId, p.keyId);
  assert.deepEqual(actual.access, access);
  result.status = 'passed';
  result.stage = 'complete';
  result.packageSha256 = manifest.sha256;
  result.permission = 'ADMINONLY';
  await save();
} catch {
  result.status = 'stopped';
  if (result.stage === 'enable-existing-publisher-images')
    result.codeRecovery = 'candidate-kept-access-requires-readback';
  else
    try {
      const current = await provider.inspect(p.functionName);
      if (
        current.packageSha256 === manifest.sha256 &&
        current.configurationToken === before.snapshot.configurationToken &&
        manifest.sha256 !== before.snapshot.packageSha256
      ) {
        await provider.updateCode({
          name: p.functionName,
          runtime: before.snapshot.runtime,
          handler: before.snapshot.handler,
          bytes: before.bytes,
          sha256: before.snapshot.packageSha256,
          expectedSnapshot: current,
        });
        await waitPackage(before.snapshot.packageSha256);
        assert.equal((await health()).releaseId, oldHealth.releaseId);
        result.codeRecovery = 'verified-original';
      } else
        result.codeRecovery =
          current.packageSha256 === before.snapshot.packageSha256
            ? 'original-unmodified'
            : 'manual-inspection-required';
    } catch {
      result.codeRecovery = 'unconfirmed-stop-before-more-writes';
    }
  await save();
  throw Error(
    'Image integration preparation stopped; inspect archived stage and recovery before retrying',
  );
}
