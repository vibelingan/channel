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
import { formalRegistration, FORMAL_BLOG as p } from './formal-policy.mjs';
import { blogWorkerSdk } from './worker-source.ts';

const env = process.env;
assertBlogBootstrapInvocation(env);
assert(env.GITHUB_TOKEN && env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY);
const registration = JSON.parse(
  Buffer.from(env.FORMAL_BLOG_REGISTRATION ?? '', 'base64').toString(),
);
const initialRegistration = formalRegistration(registration, Date.now());
let prepared = {
  key: articleIntegrationSchema.parse(initialRegistration.key),
  policy: managedArticlePolicySchema.parse(initialRegistration.policy),
};
await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(env.GITHUB_SHA);
const root = 'output/blog-formal-preparation';
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
assert.equal(before.snapshot.triggerCount, 0);
assert.equal(before.snapshot.installDependency, 'FALSE');
assert(
  [p.previousPackage, p.repairBaselinePackage, manifest.sha256].includes(
    before.snapshot.packageSha256,
  ),
  'Importer is not the observed baseline or this candidate',
);
const transaction = articleTransaction(
  blogWorkerSdk({
    env: p.envId,
    region: p.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  }).database(),
);
const existing = await transaction(async (store) => ({
  key: await store.read('articleIntegrations', p.keyId),
  policy: await store.read('articleIntegrations', prepared.policy._id),
}));
const needsRegistration = existing.key === null && existing.policy === null;
if (!needsRegistration) {
  const key = articleIntegrationSchema.parse(existing.key);
  const policy = managedArticlePolicySchema.parse(existing.policy);
  assert.equal(key._id, p.keyId);
  assert.equal(key.integrationId, p.integrationId);
  assert.equal(key.secretDigest, registration.keyDigest);
  assert.equal(key.enabled, true);
  assert(Date.parse(key.expiresAt) > Date.now(), 'Do not reenable an expired credential');
  assert.equal(policy._id, prepared.policy._id);
  assert.equal(policy.keyId, p.keyId);
  assert.equal(policy.integrationId, p.integrationId);
  prepared = { key, policy };
}
const healthUrl = `${p.apiOrigin}/api/integrations/v1/article-drafts/health`;
async function health() {
  const r = await fetchFully('GET', healthUrl, {
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
      functionName: p.functionName,
      source: env.GITHUB_SHA,
      before: before.snapshot,
      beforeHealth: oldHealth,
      candidate: manifest,
      registration: { keyId: p.keyId, integrationId: p.integrationId },
      recovery:
        'Restore only article-import code; keep data, gateway, and other functions unchanged',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
const archive = await new DefaultArtifactClient().uploadArtifact(
  `blog-formal-before-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  [`${root}/before.zip`, `${root}/candidate.zip`, `${root}/scope.json`],
  root,
  { retentionDays: 90 },
);
assert(archive.id && archive.digest);
const result: Record<string, unknown> = {
  source: env.GITHUB_SHA,
  stage: 'backup-confirmed',
  archiveId: archive.id,
  functionName: p.functionName,
  otherFunctionsWritten: false,
  routesWritten: false,
  articlesWritten: 0,
};
async function save() {
  await writeFile(`${root}/result.json`, JSON.stringify(result, null, 2));
}
async function waitPackage(hash: string) {
  const end = Date.now() + 120000;
  for (;;) {
    const state = await provider.inspect(p.functionName);
    if (
      state.status === 'Active' &&
      state.availableStatus === 'Available' &&
      state.packageSha256 === hash
    )
      return state;
    if (Date.now() >= end) throw Error('Importer activation unconfirmed');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
try {
  if (before.snapshot.packageSha256 !== manifest.sha256) {
    result.stage = 'update-importer-code';
    await save();
    await provider.updateCode({
      name: p.functionName,
      runtime: before.snapshot.runtime,
      handler: before.snapshot.handler,
      bytes,
      sha256: manifest.sha256,
      expectedSnapshot: before.snapshot,
    });
  }
  const actual = await waitPackage(manifest.sha256);
  assert.equal(actual.configurationToken, before.snapshot.configurationToken);
  assert.equal(actual.functionId, before.snapshot.functionId);
  assert.equal((await health()).releaseId, env.GITHUB_SHA);
  const denied = await fetchFully(
    'POST',
    `${p.apiOrigin}/api/integrations/v1/article-drafts/credential-rotation`,
    {
      timeoutMs: 15000,
      maxBytes: 32768,
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    },
  );
  assert.equal(denied.status, 401);
  result.stage = 'register-formal-digests';
  await save();
  if (needsRegistration)
    await transaction(async (store) => {
      assert.equal(await store.read('articleIntegrations', p.keyId), null);
      assert.equal(await store.read('articleIntegrations', prepared.policy._id), null);
      const { _id, ...key } = prepared.key;
      const { _id: policyId, ...policy } = prepared.policy;
      await store.write('articleIntegrations', _id, key);
      await store.write('articleIntegrations', policyId, policy);
    });
  const registered = await transaction(async (store) => ({
    key: await store.read('articleIntegrations', p.keyId),
    policy: await store.read('articleIntegrations', prepared.policy._id),
  }));
  assert.deepEqual(registered, prepared);
  result.stage = 'complete';
  result.status = 'passed';
  result.packageSha256 = manifest.sha256;
  result.keyId = p.keyId;
  result.credentialsArchived = false;
  await save();
} catch {
  result.status = 'stopped';
  // A transaction may have committed before its response was lost. Do not roll code back
  // underneath an ambiguously registered credential or overwrite it by running setup again.
  if (result.stage === 'register-formal-digests') {
    try {
      const actual = await transaction(async (store) => ({
        key: await store.read('articleIntegrations', p.keyId),
        policy: await store.read('articleIntegrations', prepared.policy._id),
      }));
      assert.deepEqual(actual, prepared);
      assert.equal((await health()).releaseId, env.GITHUB_SHA);
      result.stage = 'complete-after-registration-readback';
      result.status = 'passed';
      result.packageSha256 = manifest.sha256;
      result.keyId = p.keyId;
      await save();
    } catch {
      result.codeRecovery = 'candidate-kept-registration-needs-readback';
      await save();
      throw Error(
        'Registration outcome needs inspection; candidate code retained, do not repeat setup',
      );
    }
  } else {
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
      'Formal integration preparation stopped; inspect saved stage and recovery result, do not repeat blindly',
    );
  }
}
