import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { createReleaseRegionalClient } from './release-regional-client.mjs';
import { loadCatalogPreparationEvidence } from './release/catalog-preparation-evidence.mjs';
import { createGithubReadClient } from './release/github-read.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { siteArtifact } from './release/site-payload.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { recoverStoppedSiteDelivery } from './release/site-stopped-reconcile.mjs';

export function assertSiteReconcileInvocation(env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== policy.repository ||
    env.GITHUB_REF !== policy.trustedRef ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !==
      `${policy.repository}/${policy.workflowPath}@${policy.trustedRef}` ||
    env.TCB_ENV_ID !== policy.envId ||
    env.SITE_URL !== policy.siteOrigin ||
    env.CLOUDBASE_REGION !== policy.region ||
    env.SITE_RECONCILE_CONFIRM !== 'STOPPED_HTML_ONLY' ||
    !/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(env.SITE_RECONCILE_RUN_ID ?? '') ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    env.SITE_RECONCILE_RUN_ID === `site-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` ||
    !env.TENCENTCLOUD_SECRETID ||
    !env.TENCENTCLOUD_SECRETKEY ||
    !env.GITHUB_TOKEN
  )
    throw Error('Pinned manual stopped-HTML reconciliation required');
  return policy;
}

export function assertStoppedCatalogReceipt(receipt, context) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.purpose, 'catalog-seo-regional-v1');
  assert.equal(receipt.runId, context.runId);
  assert.equal(receipt.codeSha, context.codeSha);
  assert.equal(
    receipt.functionName,
    `seo-catalog-region-${context.githubRunId}-${context.attempt}`,
  );
  assert.equal(receipt.environment, policy.envId);
  assert.equal(receipt.created, true);
  assert.equal(receipt.cleaned, true);
  assert.equal(receipt.unconfirmed, false);
  assert.equal(receipt.websiteWrites, 0);
  assert.equal(receipt.businessWrites, 0);
  assert.ok(
    Array.isArray(receipt.calls) && receipt.calls.length > 0 && receipt.calls.length <= 50000,
  );
  const allowed = new Set(['health', 'seed', 'prepare.step', 'delivery.begin', 'delivery.end']);
  for (const call of receipt.calls) {
    assert.ok(allowed.has(call?.action));
    assert.ok(['completed', 'readback-confirmed'].includes(call.state));
    assert.match(call.requestId ?? '', /^[A-Za-z0-9:_-]{1,200}$/);
  }
  assert.ok(receipt.calls.some((call) => call.action === 'health'));
  assert.ok(receipt.calls.some((call) => call.action === 'delivery.end'));
}

export async function assertStoppedFunctionsAbsent(functions, names) {
  const found = new Set();
  for (let offset = 0; offset < 1000; offset += 100) {
    const rows = await functions.listFunctions(100, offset);
    assert.ok(Array.isArray(rows) && rows.length <= 100);
    for (const row of rows) {
      assert.equal(typeof row?.FunctionName, 'string');
      assert.ok(row.FunctionName && !found.has(row.FunctionName));
      found.add(row.FunctionName);
    }
    if (rows.length < 100) {
      for (const name of names) assert.ok(!found.has(name), `Stopped worker still exists: ${name}`);
      return;
    }
  }
  throw Error('Complete function inventory could not be established');
}

export async function runSiteReconcile(env = process.env) {
  assertSiteReconcileInvocation(env);
  const output = resolve('output/site-reconcile');
  await mkdir(output, { recursive: true });
  const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
  const api = createGithubReadClient({ policy, token: env.GITHUB_TOKEN });
  await github.requireCI(env.GITHUB_SHA);
  const manager = new CloudBase({
    envId: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  });
  const regional = await createReleaseRegionalClient({
    manager,
    policy,
    ownerRunId: `reconcile-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}`,
    codeSha: env.GITHUB_SHA,
    directory: resolve(output, 'release-regional'),
  });
  let record = {
    status: 'preflight',
    runId: env.SITE_RECONCILE_RUN_ID,
    executorSha: env.GITHUB_SHA,
    websiteWrites: 0,
    businessWrites: 0,
  };
  let oldReceipt;
  const save = () =>
    writeFile(resolve(output, 'result.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    await save();
    const result = await recoverStoppedSiteDelivery({
      coordinator: regional.coordinator,
      github: api,
      policy,
      runId: env.SITE_RECONCILE_RUN_ID,
      loadCandidate: async ({ artifact }) => {
        const directory = resolve(output, 'original-candidate');
        const metadata = await github.download(artifact.artifactId, directory, {
          acceptedRunId: artifact.runId,
        });
        return siteArtifact({
          directory,
          policy,
          run: metadata,
          retainedProof: metadata.retainedProof ?? null,
        });
      },
      verifyQuiescence: async (context) => {
        if (!oldReceipt) {
          const run = await api.api(
            `/actions/runs/${context.githubRunId}/attempts/${context.attempt}`,
          );
          oldReceipt = await loadCatalogPreparationEvidence({
            github: api,
            artifacts: new DefaultArtifactClient(),
            token: env.GITHUB_TOKEN,
            directory: resolve(output, 'original-evidence'),
            run,
            artifactName: `site-delivery-evidence-${context.githubRunId}-${context.attempt}`,
            regionalPath: 'regional/result.json',
          });
        }
        assertStoppedCatalogReceipt(oldReceipt, context);
        await assertStoppedFunctionsAbsent(manager.functions, [
          `seo-catalog-region-${context.githubRunId}-${context.attempt}`,
          `seo-release-region-${context.githubRunId}-${context.attempt}`,
        ]);
        return { ...context, functionsAbsent: true, oldJobCompleted: true, checkedAt: Date.now() };
      },
    });
    record = { ...record, ...result };
    await save();
    console.log('Stopped HTML delivery reconciled; no website or business data was changed.');
  } catch (error) {
    record = {
      ...record,
      status: 'reconciliation-incomplete',
      error: error?.code ?? 'STOPPED_SITE_CHECK_FAILED',
      reconcileStage: error?.reconcileStage ?? null,
      underlyingCode: error?.underlyingCode ?? null,
    };
    await save();
    throw error;
  } finally {
    await regional.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runSiteReconcile();
