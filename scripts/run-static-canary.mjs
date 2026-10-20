import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CloudBase from '@cloudbase/manager-node';
import { createCanaryProvider } from './release/canary-provider.mjs';
import { canaryArtifact, createCanaryPayload } from './release/canary.mjs';
import { createGithubSource, validateInvocation } from './release/github-source.mjs';
import { executeManualCanary, planManualCanary } from './release/orchestrator.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';

export async function runStaticCanary(command, env = process.env) {
  if (!['prepare', 'run'].includes(command)) throw new Error('Use prepare or run');
  const policy = JSON.parse(
    readFileSync(new URL('./release/static-canary-policy.json', import.meta.url), 'utf8'),
  );
  const invocation = validateInvocation(env, policy);
  if (
    !['plan', 'execute'].includes(env.CANARY_MODE) ||
    !['initialize', 'publish', 'restore'].includes(env.CANARY_ACTION)
  )
    throw new Error('Invalid manual operation');
  if (env.CANARY_MODE === 'execute' && !policy.enabled)
    throw new Error('Live canary execution disabled by committed policy');
  const github = createGithubSource({ policy, token: env.GITHUB_TOKEN });
  await github.requireCI(invocation.codeSha);
  if (
    env.TCB_ENV_ID !== policy.envId ||
    env.SITE_URL !== policy.siteOrigin ||
    env.CLOUDBASE_REGION !== policy.region
  )
    throw new Error('Workflow environment differs from pinned canary target');
  if (!env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY)
    throw new Error('Scoped cloud credentials missing');
  const credentials = {
    envId: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  };
  const manager = new CloudBase(credentials);
  const provider = createCanaryProvider({ manager, policy });
  const readiness = await provider.controlPlane({ execute: env.CANARY_MODE === 'execute' });
  const requireSdk = createRequire(
    new URL('../packages/media-storage/package.json', import.meta.url),
  );
  const sdk = requireSdk('@cloudbase/node-sdk');
  const db = sdk.init({ ...credentials, env: policy.envId }).database();
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
    policy,
  });
  const output = resolve('output/static-canary');
  mkdirSync(output, { recursive: true });
  const save = (name, value) =>
    writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const result = (key, value) => {
    if (!env.GITHUB_OUTPUT) throw new Error('GitHub output channel required');
    appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  };
  if (command === 'prepare') {
    let artifactId = env.CANARY_ARTIFACT_ID;
    if (env.CANARY_ACTION === 'restore') {
      if (!env.CANARY_RESTORE_RUN_ID) throw new Error('Explicit accepted restore run required');
      const run = await coordinator.runStatus(env.CANARY_RESTORE_RUN_ID);
      if (run.state !== 'SUCCEEDED' || run.scopeKey !== 'canary' || !run.accepted)
        throw new Error('Restore source is not an accepted canary');
      if (artifactId && artifactId !== run.composition.static.artifact.artifactId)
        throw new Error('Restore artifact differs from accepted source');
      artifactId = run.composition.static.artifact.artifactId;
    }
    const fresh = env.CANARY_MODE === 'plan' && env.CANARY_ACTION !== 'restore' && !artifactId;
    if (fresh)
      createCanaryPayload({
        directory: join(output, 'payload'),
        policy,
        configuration: await provider.readConfiguration(),
        variant: env.CANARY_VARIANT,
        codeSha: invocation.codeSha,
      });
    else await github.metadata(artifactId);
    result('fresh', String(fresh));
    result('artifact_id', artifactId || '');
    return;
  }
  const artifactId = env.CANARY_RESOLVED_ARTIFACT_ID;
  const options =
    env.CANARY_FRESH === 'true' && env.CANARY_MODE === 'plan'
      ? { allowCurrentRunId: invocation.runId }
      : {};
  const downloaded = new Map();
  const download = async (id, acceptedSeal) => {
    let source = downloaded.get(id);
    if (!source) {
      const directory = join(output, `artifact-${id}`);
      const run = await github.download(id, directory, options);
      source = { directory, run };
      downloaded.set(id, source);
    } else source = { ...source, run: (await github.metadata(id, options)).metadata };
    return canaryArtifact({ ...source, policy, acceptedSeal });
  };
  const loadAccepted = (run) =>
    download(run.composition.static.artifact.artifactId, run.accepted.seals.static);
  const input =
    env.CANARY_ACTION === 'restore'
      ? await loadAccepted(await coordinator.runStatus(env.CANARY_RESTORE_RUN_ID))
      : await download(artifactId);
  if (input.envelope.artifact.artifactId !== artifactId)
    throw new Error('Resolved artifact differs from requested input');
  const request = {
    action: env.CANARY_ACTION,
    expectedActivationId: env.CANARY_EXPECTED_ACTIVATION_ID,
    restoreRunId: env.CANARY_RESTORE_RUN_ID || null,
    reason: env.CANARY_REASON,
    executorSha: invocation.codeSha,
  };
  const args = { policy, coordinator, provider, input, request, loadAccepted };
  const planned = await planManualCanary(args);
  save('plan.json', { ...planned.review, readiness });
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Static canary reviewed plan\n\n\`\`\`json\n${JSON.stringify(planned.review, null, 2)}\n\`\`\`\n\nExecution enabled: ${policy.enabled}. Functions and business data: not-run.\n`,
    );
  if (env.CANARY_MODE === 'execute') {
    const completed = await executeManualCanary({
      ...args,
      token: env.CANARY_PLAN_TOKEN,
      runId: `canary-${invocation.runId}-${invocation.attempt}`,
      owner: invocation,
    });
    save('accepted.json', completed);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `\nAccepted activation: \`${completed.activation.activationId}\`. Search notifications: 0.\n`,
      );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStaticCanary(process.argv[2]).catch(() => {
    console.error(
      'Manual canary stopped. Inspect the plan and release journal; do not retry an unresolved operation. No automatic recovery was requested.',
    );
    process.exitCode = 1;
  });
}
