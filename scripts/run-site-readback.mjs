import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import { planSiteReleaseCandidate } from './hosting-recovery.mjs';
import { createCanaryProvider } from './release/canary-provider.mjs';
import { createGithubReadClient } from './release/github-read.mjs';
import { identity } from './release/input.mjs';
import { publicBuildEnvironment } from './release/public-build-env.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { siteArtifact } from './release/site-payload.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { siteReadbackEvidence, verifySiteReadback } from './release/site-readback.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import {
  createCloudbaseReleaseDatabase,
  createCloudbaseReleaseStore,
} from './release/store-cloudbase.mjs';

const env = process.env;
if (
  env.GITHUB_ACTIONS !== 'true' ||
  env.GITHUB_REPOSITORY !== policy.repository ||
  env.GITHUB_REF !== policy.trustedRef ||
  env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
  env.GITHUB_WORKFLOW_REF !== `${policy.repository}/${policy.workflowPath}@${policy.trustedRef}` ||
  env.TCB_ENV_ID !== policy.envId ||
  env.SITE_URL !== policy.siteOrigin ||
  env.CLOUDBASE_REGION !== policy.region ||
  env.SITE_READBACK_CONFIRM !== 'FINAL_READ_ONLY' ||
  !/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(env.SITE_READBACK_RUN_ID ?? '') ||
  !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
  !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
  !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !env.GITHUB_TOKEN
)
  throw Error('Pinned manual read-only acceptance invocation required');
const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
const api = createGithubReadClient({ policy, token: env.GITHUB_TOKEN });
await github.requireCI(env.GITHUB_SHA);
const config = {
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
};
const db = createCloudbaseReleaseDatabase({ ...config, env: policy.envId });
const coordinator = createReleaseCoordinator({
  store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
  policy,
});
const runId = env.SITE_READBACK_RUN_ID;
const output = resolve('output/site-readback');
await mkdir(output, { recursive: true });
const record = {
  runId,
  executorSha: env.GITHUB_SHA,
  websiteWrites: 0,
  operation: 'continue-final-read-only-acceptance',
  status: 'preflight',
};
const save = () => writeFile(resolve(output, 'result.json'), JSON.stringify(record, null, 2));
await save();
let guard;
let step;
let heartbeat;
let failure;
let renewing = false;
let pathRead = 0;
async function readPublicPaths() {
  const path = resolve(output, `public-paths-${++pathRead}.json`);
  await new Promise((done, reject) => {
    const child = spawn(
      resolve('apps/site/node_modules/.bin/tsx'),
      ['apps/site/scripts/prepare-product-public-paths.ts', path],
      {
        stdio: 'inherit',
        env: publicBuildEnvironment(env, {
          SITE_URL: policy.siteOrigin,
          SEO_CATALOG_API_ORIGIN: policy.siteOrigin,
        }),
      },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(Error('Public product inventory unreadable')),
    );
  });
  return JSON.parse(await readFile(path, 'utf8'));
}
try {
  let run = await coordinator.runStatus(runId);
  const artifact = run.composition.static.artifact;
  const metadata = await github.download(
    artifact.artifactId,
    resolve(output, 'original-candidate'),
    { acceptedRunId: artifact.runId },
  );
  const input = siteArtifact({
    directory: resolve(output, 'original-candidate'),
    policy,
    run: metadata,
  });
  await github.requireCI(input.envelope.codeSha);
  const response = await db
    .collection('siteReleaseSteps')
    .where({ runId, kind: 'write' })
    .limit(1000)
    .get();
  if (response?.code || !Array.isArray(response?.data))
    throw Error('Original write evidence unreadable');
  const steps = response.data;
  const evidence = siteReadbackEvidence({ run, input, steps, policy });
  const publicPaths = await readPublicPaths();
  const candidate = planSiteReleaseCandidate({
    artifactInput: input,
    currentOwnedPaths: [...input.staticManifest.entries.map((e) => e.path), ...evidence.removed],
    publicProductPaths: publicPaths,
  });
  if (candidate.stateSha256 !== evidence.hash)
    throw Error('Current public catalog differs from candidate');
  const provider = createCanaryProvider({ manager: new CloudBase(config), policy });
  await provider.controlPlane({ execute: true });
  const status = await coordinator.status({ scopeKey: 'site' });
  const owner = status.target.lease;
  const match = /^github:vibelingan\/channel:([1-9][0-9]*):attempt-([1-9][0-9]*)$/.exec(
    owner?.runnerRef ?? '',
  );
  if (!match || match[1] === env.GITHUB_RUN_ID) throw Error('Original workflow owner unproven');
  const previous = await api.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
  if (
    previous.status !== 'completed' ||
    previous.path !== policy.workflowPath ||
    previous.head_branch !== policy.trustedRef.slice(11) ||
    previous.event !== 'workflow_dispatch' ||
    previous.repository?.full_name !== policy.repository ||
    previous.head_repository?.full_name !== policy.repository
  )
    throw Error('Previous owner has not stopped in the trusted workflow');
  // This is the only takeover allowed: every cloud write was already confirmed.
  guard = await coordinator.resumeReadOnlyAcceptance({
    runId,
    expectedVersion: status.target.version,
    expectedFence: owner.fence,
    ownerRunId: `readback-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}`,
    proof: {
      runnerRef: owner.runnerRef,
      checkedAt: Date.now(),
      job: {
        status: 'completed',
        evidenceRef: `github:${previous.id}:attempt-${match[2]}:${previous.conclusion}`,
      },
      cloud: { status: 'quiescent', kind: 'hosting-final-read-only' },
    },
  });
  record.status = 'checking-existing-website';
  await save();
  heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      await coordinator.renew(guard);
    } catch (error) {
      failure = error;
    } finally {
      renewing = false;
    }
  }, 30000);
  const check = () => {
    if (failure) throw failure;
  };
  run = await coordinator.runStatus(runId);
  const observed = await verifySiteReadback({
    run,
    input,
    steps,
    policy,
    // No upload/remove/configuration callback is exposed to this operation.
    provider: {
      readInventory: () => provider.readInventory(),
      readConfiguration: () => provider.readConfiguration(),
    },
    postCheck: async () => {
      check();
      await new Promise((done, reject) => {
        const child = spawn(
          resolve('node_modules/.bin/playwright'),
          ['test', 'tests/e2e/seo-public-live.spec.ts', '--project=chromium', '--retries=0'],
          {
            stdio: 'inherit',
            env: {
              PATH: env.PATH,
              HOME: env.HOME,
              CI: 'true',
              GITHUB_ACTIONS: 'true',
              E2E_SITE_URL: policy.siteOrigin,
              E2E_API_URL: `https://${policy.envId}.service.tcloudbase.com`,
              E2E_SEO_PUBLIC_LIVE: '1',
              E2E_RECORD_ARTIFACTS: '0',
            },
          },
        );
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? done() : reject(Error('Actual public browser checks failed')),
        );
      });
      check();
      if (identity(await readPublicPaths()) !== identity(publicPaths))
        throw Error('Public product inventory changed during acceptance');
    },
  });
  check();
  step = await coordinator.beginStep({
    guard,
    runId,
    stepId: randomUUID(),
    component: 'scope',
    kind: 'accept',
    beforeHash: observed.observedHash,
    afterHash: observed.observedHash,
    subject: 'accept',
    verifySubject: 'accept',
    executionId: randomUUID(),
  });
  await coordinator.confirmStep({
    guard,
    runId,
    stepId: step.stepId,
    receipt: {
      status: 'verified',
      executionId: step.executionId,
      planSha256: step.planSha256,
      operationId: step.operationId,
      intentHash: step.intentHash,
      subject: 'accept',
      expectedHash: step.afterHash,
      observedHash: observed.observedHash,
      terminal: true,
    },
  });
  const accepted = await coordinator.commitRun({
    guard,
    runId,
    changeSetRef: `github:${env.GITHUB_RUN_ID}:read-only-acceptance`,
  });
  record.status = 'accepted';
  record.observation = observed;
  record.accepted = accepted;
  await save();
  console.log(`Existing website ${runId} accepted without repeating any website write.`);
} catch (error) {
  record.status = 'readback-incomplete';
  record.error = error.message;
  await save();
  // Never clear uncertainty or start restoration merely because this read failed.
  throw error;
} finally {
  if (heartbeat) clearInterval(heartbeat);
}
