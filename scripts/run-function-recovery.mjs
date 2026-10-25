import { createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CloudBase from '@cloudbase/manager-node';
import { createCanaryProvider } from './release/canary-provider.mjs';
import { verifyFunctionBaseline } from './release/function-baseline.mjs';
import { createFunctionGithubSource } from './release/function-github-source.mjs';
import {
  createFunctionHealthProbe,
  createFunctionHealthReader,
} from './release/function-health.mjs';
import {
  createCloudbaseContractReader,
  createFunctionObserver,
} from './release/function-observation.mjs';
import {
  executeManualFunctionRecovery,
  planManualFunctionRecovery,
} from './release/function-orchestrator.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { writeFunctionReportArtifact } from './release/function-report-artifact.mjs';
import { produceFunctionCompatibilityReport } from './release/function-report.mjs';
import { runFunctionCompatibilityTests } from './release/function-test-runner.mjs';
import { identity } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import {
  createCloudbaseReleaseDatabase,
  createCloudbaseReleaseStore,
} from './release/store-cloudbase.mjs';

export function validateFunctionInvocation(env, policy) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REPOSITORY !== policy.repository ||
    env.GITHUB_REF !== policy.trustedRef ||
    env.GITHUB_JOB !== 'functions' ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT) ||
    !['observe', 'certify', 'report', 'plan', 'execute'].includes(env.FUNCTION_MODE)
  )
    throw new Error('Untrusted manual function invocation');
  if (env.FUNCTION_MODE === 'execute' && (policy.enabled !== true || !env.FUNCTION_PLAN_TOKEN))
    throw new Error('Live function execution disabled or missing reviewed token');
  return {
    codeSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    owner: {
      ownerRunId: `github-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
      runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}:functions`,
    },
  };
}

export async function runFunctionRecovery(command, env = process.env) {
  const checked = async (stage, callback) => {
    try {
      return await callback();
    } catch (error) {
      throw Object.assign(new Error('Function recovery preflight unconfirmed'), {
        stage,
        detailStage: error?.stage,
        functionName: error?.functionName,
        code: error?.code,
      });
    }
  };
  if (!['prepare', 'run'].includes(command)) throw new Error('Use prepare or run');
  const policy = JSON.parse(
    readFileSync(new URL('./release/function-recovery-policy.json', import.meta.url), 'utf8'),
  );
  const invocation = validateFunctionInvocation(env, policy);
  const github = createFunctionGithubSource({ policy, token: env.GITHUB_TOKEN });
  await checked('require-ci', () => github.requireCI(invocation.codeSha));
  if (
    env.TCB_ENV_ID !== policy.envId ||
    env.SITE_URL !== policy.siteOrigin ||
    env.CLOUDBASE_REGION !== policy.region ||
    (env.PUBLIC_API_BASE_URL && env.PUBLIC_API_BASE_URL !== policy.apiOrigin) ||
    !env.TENCENTCLOUD_SECRETID ||
    !env.TENCENTCLOUD_SECRETKEY
  )
    throw new Error('Scoped credentials or pinned function target missing');
  const credentials = {
    envId: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  };
  const manager = new CloudBase(credentials);
  const readiness = await checked('control-plane', () =>
    createCanaryProvider({ manager, policy }).controlPlane({
      execute: env.FUNCTION_MODE === 'execute',
    }),
  );
  const db = createCloudbaseReleaseDatabase({ ...credentials, env: policy.envId });
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
    policy,
  });
  const target = { envId: policy.envId, siteOrigin: policy.siteOrigin };
  const configurationKey = createHmac('sha256', Buffer.from(credentials.secretKey))
    .update(`channel-function-observation:v1:${identity(target)}`)
    .digest();
  const provider = createCloudbaseFunctionProvider({
    manager,
    target,
    region: policy.region,
    names: policy.observeFunctions ?? policy.functions,
    configurationKey,
  });
  const reader = createCloudbaseContractReader({ db, policy });
  const observer = createFunctionObserver({
    policy,
    provider,
    readContractState: reader.read,
    readHealth: createFunctionHealthReader({ target, apiOrigin: policy.apiOrigin }),
  });
  const output = resolve('output/function-recovery');
  mkdirSync(output, { recursive: true });
  const save = (name, value) =>
    writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const setOutput = (name, value) => {
    if (!env.GITHUB_OUTPUT) throw new Error('GitHub output channel required');
    appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  const cache = new Map();
  const download = async (id, options = {}) => {
    let item = cache.get(id);
    if (!item) {
      item = await github.download(id, join(output, `artifact-${id}`), 'payload', options);
      cache.set(id, item);
    }
    const source = await github.metadata(id, 'payload', options);
    const artifact = {
      repository: policy.repository,
      workflowPath: source.source.workflowPath,
      runId: source.source.runId,
      artifactId: source.source.artifact.id,
      manifestSha256: item.manifestSha256,
      expiresAt: source.source.artifact.expiresAt,
    };
    return {
      ...item,
      envelope: { ...item.body, artifact },
      run: source.source,
      policy: {
        repository: policy.repository,
        workflowPath: policy.workflowPath,
        event: 'workflow_dispatch',
        ref: policy.trustedRef,
        target,
        scope: { kind: 'site' },
      },
    };
  };
  const names = (env.FUNCTION_NAMES ?? '').split(',');
  if (
    env.FUNCTION_MODE !== 'observe' &&
    (!names.length ||
      names.some((name) => !policy.functions.includes(name)) ||
      new Set(names).size !== names.length)
  )
    throw new Error('Explicit allowlisted function names required');
  const loadAccepted = async (run, selectedNames) => {
    if (run.state !== 'SUCCEEDED' || run.scopeKey !== 'site' || !run.accepted)
      throw new Error('Explicit accepted site run required');
    const keys = selectedNames.map((name) => `function:${name}`);
    const part = run.composition[keys[0]];
    if (
      !part ||
      keys.some(
        (key) =>
          identity(run.composition[key]?.artifact) !== identity(part.artifact) ||
          identity(run.accepted.seals[key]) !== identity(run.accepted.seals[keys[0]]),
      )
    )
      throw new Error(
        'Selected functions require one accepted archive and matching component seals',
      );
    const input = {
      ...(await download(part.artifact.artifactId)),
      acceptedSeal: run.accepted.seals[keys[0]],
    };
    verifyFunctionBaseline({ ...input, policy: input.policy, now: Date.now() });
    return input;
  };
  if (command === 'prepare') {
    const inspected = await checked('observe', () => observer.inspect());
    const site = await checked('site-state', () => coordinator.status({ scopeKey: 'site' }));
    const reasons = [...inspected.reasons];
    if (!site.scope?.active) reasons.push('MISSING_ACCEPTED_SITE_BASELINE');
    if (site.pendingStep || site.target?.currentRunId || site.target?.dirtyRunId)
      reasons.push('SITE_UNRESOLVED_OR_BUSY');
    if (!policy.compatibilitySuites.length) reasons.push('MISSING_REVIEWED_COMPATIBILITY_SUITES');
    save('observation.json', {
      ...inspected,
      controlPlane: readiness,
      contractDocumentId: reader.documentId,
      site: { state: site.state, activationId: site.scope?.active?.activationId ?? null },
      recoveryReadiness: {
        status: reasons.length || !policy.enabled ? 'manual-required' : 'ready',
        enabled: policy.enabled,
        reasons: [...new Set(reasons)],
      },
    });
    if (env.FUNCTION_MODE === 'observe') {
      setOutput('fresh', 'false');
      return;
    }
    if (!inspected.observation)
      throw new Error(`Production compatibility unavailable: ${inspected.reasons.join(',')}`);
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(env.FUNCTION_RESTORE_RUN_ID))
      throw new Error('Explicit accepted run required');
    const baseline = await loadAccepted(
      await coordinator.runStatus(env.FUNCTION_RESTORE_RUN_ID),
      names,
    );
    const baselines = names.map((name) => ({
      ...baseline.envelope.functions.find((x) => x.name === name),
      codeSha: baseline.envelope.codeSha,
    }));
    if (env.FUNCTION_MODE === 'certify') {
      const tests = runFunctionCompatibilityTests({
        root: resolve('.'),
        directory: baseline.directory,
        baselines,
        observation: inspected.observation,
        policy,
      });
      mkdirSync(join(output, 'tests'));
      writeFileSync(join(output, 'tests/test-results.json'), JSON.stringify(tests), { flag: 'wx' });
      setOutput('fresh', 'false');
      if (tests.status !== 'passed')
        throw new Error(`Compatibility suites unavailable: ${tests.reasons.join(',')}`);
      return;
    }
    if (env.FUNCTION_MODE === 'report') {
      const tests = await github.download(
        env.FUNCTION_TEST_ARTIFACT_ID,
        join(output, 'test-evidence'),
        'tests',
      );
      await github.requireCI(tests.run.headSha);
      const report = produceFunctionCompatibilityReport({
        target,
        baselines,
        observation: inspected.observation,
        evidence: tests.body,
        source: tests.evidenceSource,
        suitePolicy: policy.compatibilitySuites,
      });
      writeFunctionReportArtifact({
        directory: join(output, 'payload'),
        report,
        target,
        codeSha: invocation.codeSha,
        releaseId: `function-proof-${invocation.runId}`,
      });
      setOutput('fresh', 'true');
      return;
    }
    setOutput('fresh', 'false');
    return;
  }
  const fresh = env.FUNCTION_MODE === 'report';
  const compatibilityId =
    env.FUNCTION_RESOLVED_ARTIFACT_ID || env.FUNCTION_COMPATIBILITY_ARTIFACT_ID;
  const request = {
    names,
    restoreRunId: env.FUNCTION_RESTORE_RUN_ID,
    expectedActivationId: env.FUNCTION_EXPECTED_ACTIVATION_ID,
    compatibilityArtifactId: compatibilityId,
    reason: env.FUNCTION_REASON,
  };
  const args = {
    policy,
    coordinator,
    provider,
    observer,
    probe: createFunctionHealthProbe({ target, apiOrigin: policy.apiOrigin }),
    loadAccepted,
    loadCompatibility: (id) => download(id, fresh ? { allowCurrentRunId: invocation.runId } : {}),
    request,
    executorSha: invocation.codeSha,
    token: env.FUNCTION_PLAN_TOKEN || undefined,
  };
  if (env.FUNCTION_MODE === 'execute')
    save(
      'accepted.json',
      await executeManualFunctionRecovery({
        ...args,
        runId: `function-restore-${invocation.runId}-${env.GITHUB_RUN_ATTEMPT}`,
        owner: invocation.owner,
      }),
    );
  else {
    const prepared = await planManualFunctionRecovery(args);
    save('plan.json', { review: prepared.review, plan: prepared.plan, controlPlane: readiness });
  }
}

export function safeFunctionFailure(error) {
  return {
    status: 'stopped',
    stage:
      typeof error?.stage === 'string' && /^[a-z-]{1,40}$/.test(error.stage)
        ? error.stage
        : 'preflight-or-plan',
    detailStage:
      typeof error?.detailStage === 'string' && /^[a-z-]{1,40}$/.test(error.detailStage)
        ? error.detailStage
        : undefined,
    functionName:
      typeof error?.functionName === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(error.functionName)
        ? error.functionName
        : undefined,
    code:
      typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)
        ? error.code
        : 'UNCONFIRMED',
    evidence: 'Inspect retained observation/plan and release journal; no automatic retry.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runFunctionRecovery(process.argv[2]).catch((error) => {
    console.error(JSON.stringify(safeFunctionFailure(error)));
    process.exitCode = 1;
  });
