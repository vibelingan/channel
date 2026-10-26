import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { articleTransaction } from '../../packages/db/src/article-repository.ts';
import { readHttpWithRetry } from '../read-http-retry.mjs';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { identity } from '../release/input.mjs';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import {
  assertImportRoute,
  assertImportSetupInput,
  pilotIntegration,
} from './import-setup-policy.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './site-baseline.mjs';
import { blogWorkerSdk } from './worker-source.ts';
const env = process.env;
const site = assertBlogBootstrapInvocation(env);
const p = assertImportSetupInput(env);
assert(env.GITHUB_TOKEN && env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY);
const source = createSiteGithubSource({ token: env.GITHUB_TOKEN });
await source.requireCI(env.GITHUB_SHA);
await source.requireCI(p.codeSha);
const manager = new CloudBase({
  envId: p.envId,
  region: p.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const provider = createCloudbaseFunctionProvider({
  manager,
  target: { envId: p.envId, siteOrigin: site.siteOrigin },
  region: p.region,
  names: [p.functionName],
  configurationKey: undefined,
});
const snapshot = await provider.capture(p.functionName);
assert.equal(snapshot.snapshot.packageSha256, p.packageSha256);
assert.equal(snapshot.snapshot.packageBytes, p.packageBytes);
assert.equal(snapshot.snapshot.installDependency, 'FALSE');
assert.equal(snapshot.snapshot.runtime, 'Nodejs20.19');
assert.equal(snapshot.snapshot.handler, 'index.main');
assert.equal(snapshot.snapshot.role, 'TCB_QcsRole');
assert.equal(snapshot.snapshot.triggerCount, 0);
const before = await readBlogSiteBaseline();
const mcp = await connectBlogMcp();
const output = 'output/article-import-setup';
await mkdir(output, { recursive: true });
const result: { stage: string; status: string; [key: string]: unknown } = {
  stage: 'preflight',
  status: 'running',
  operation: env.IMPORT_SETUP_OPERATION,
  source: env.GITHUB_SHA,
  target: { envId: p.envId, siteOrigin: site.siteOrigin },
};
const save = () => writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
try {
  for (const name of ['articleIntegrations', 'articleImports', 'articleImportLimits']) {
    const permission = await mcp.call('queryPermissions', {
      action: 'getResourcePermission',
      resourceType: 'noSqlDatabase',
      resourceId: name,
    });
    assert.equal(permission.data.aclTag, 'ADMINONLY');
  }
  const initial = await mcp.call('queryGateway', { action: 'listRoutes' });
  const own = initial.data.routes.filter(
    (r: { Domain: string; Path: string }) => r.Domain === p.domain && r.Path === p.path,
  );
  assert(own.length <= 1);
  if (own[0]) assertImportRoute(own[0]);
  const transaction = articleTransaction(
    blogWorkerSdk({
      env: p.envId,
      region: p.region,
      secretId: env.TENCENTCLOUD_SECRETID,
      secretKey: env.TENCENTCLOUD_SECRETKEY,
    }).database(),
  );
  const current = await transaction((store) => store.read('articleIntegrations', p.keyId));
  const prepared = pilotIntegration(
    current,
    env.IMPORT_SETUP_KEY_DIGEST,
    env.IMPORT_SETUP_OPERATION,
  );
  const plan = {
    schemaVersion: 1,
    target: result.target,
    operation: result.operation,
    source: env.GITHUB_SHA,
    functionSource: p.codeSha,
    functionPackageSha256: p.packageSha256,
    routeBefore: own[0] ?? null,
    route: { domain: p.domain, path: p.path, target: p.functionName },
    keyId: p.keyId,
    keyExisted: current !== null,
    credentialStored: 'SHA-256 only',
    recovery: 'Revoke only the owned pilot key; keep drafts and existing services',
    ordinarySiteBefore: before,
  };
  await writeFile(`${output}/preparation.json`, JSON.stringify(plan, null, 2), { flag: 'wx' });
  const archived = await new DefaultArtifactClient().uploadArtifact(
    `article-import-preparation-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    [`${output}/preparation.json`],
    output,
    { retentionDays: 90 },
  );
  assert(archived.id && archived.digest);
  result.preparationArtifactId = String(archived.id);
  if (env.IMPORT_SETUP_OPERATION === 'initialize' && !own.length) {
    result.stage = 'create-standard-route';
    await save();
    await mcp.call('manageGateway', {
      action: 'createRoute',
      domain: p.domain,
      path: p.path,
      targetName: p.functionName,
      upstreamResourceType: 'SCF',
      enablePathTransmission: true,
      enableSafeDomain: false,
      auth: false,
      route: { enable: true },
    });
  }
  const after = await mcp.call('queryGateway', { action: 'listRoutes' });
  const route = after.data.routes.find(
    (r: { Domain: string; Path: string }) => r.Domain === p.domain && r.Path === p.path,
  );
  assertImportRoute(route);
  const unrelated = (rows: Array<{ Domain: string; Path: string }>) =>
    rows
      .filter((r) => r.Domain !== p.domain || r.Path !== p.path)
      .sort((a, b) => identity(a).localeCompare(identity(b)));
  assert.equal(identity(unrelated(after.data.routes)), identity(unrelated(initial.data.routes)));
  result.stage = 'check-actual-http';
  await save();
  const endpoint = `https://${p.domain}${p.path}/v1/article-drafts`;
  const deadline = Date.now() + 90000;
  for (;;) {
    const response = await readHttpWithRetry('GET', `${endpoint}/health`, {
      timeoutMs: Math.min(15000, Math.max(1, deadline - Date.now())),
      maxBytes: 32768,
      redirect: 'error',
    });
    if (response.status === 200) {
      const health = JSON.parse(response.body.toString());
      assert.equal(health.data.releaseId, p.codeSha);
      assert.equal(health.data.apiContract, 'article-drafts-v1');
      break;
    }
    if (response.status !== 404 || Date.now() >= deadline)
      throw Error('New standard draft route health is unconfirmed');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const denied = await readHttpWithRetry('GET', `${endpoint}/article-import-${'0'.repeat(64)}`, {
    timeoutMs: 15000,
    maxBytes: 32768,
    redirect: 'error',
  });
  assert.equal(denied.status, 401);
  result.stage = 'save-pilot-credential';
  await save();
  await transaction(async (store) => {
    const found = await store.read('articleIntegrations', p.keyId);
    assert.equal(identity(found), identity(current));
    const { _id, ...body } = prepared;
    await store.write('articleIntegrations', _id, body);
  });
  const actual = await transaction((store) => store.read('articleIntegrations', p.keyId));
  assert.equal(identity(actual), identity(prepared));
  await checkBlogSiteBaseline(before);
  const final = await provider.inspect(p.functionName);
  assert.equal(final.packageSha256, p.packageSha256);
  assert.equal(final.configurationToken, snapshot.snapshot.configurationToken);
  assert.equal(final.functionId, snapshot.snapshot.functionId);
  result.stage = 'complete';
  result.status = 'passed';
  result.functionSource = p.codeSha;
  result.route = { domain: p.domain, path: p.path };
  result.credential = {
    keyId: p.keyId,
    enabled: prepared.enabled,
    configRevision: prepared.configRevision,
    expiresAt: prepared.expiresAt,
  };
  result.websiteWrites = 0;
  result.businessWrites = 0;
  result.unrelatedRoutesChanged = false;
  await save();
  console.log(JSON.stringify(result));
} catch (error) {
  result.status = 'stopped';
  result.error = error instanceof Error ? error.name : 'UNCONFIRMED';
  await save();
  throw Error('Draft integration setup stopped; inspect its saved stage before another write');
} finally {
  await mcp.close();
}
