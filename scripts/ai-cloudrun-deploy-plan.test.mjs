/**
 * The AI CloudRun deploy plan: what gets uploaded, how each service is
 * configured, and how a deploy decides that it worked.
 *
 * Every mistake here is invisible until a live deploy: a worker left reachable
 * from the internet, a setting removed from the manifest that stays on the
 * service anyway, a knowledge-base proof that does not match what the worker
 * checks it against, or "deployed" read off the previous deployment. Each is
 * pinned here instead.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  STAGING_EXCLUDES,
  cloudRunDeployArgs,
  deployContextFromEnv,
  deployProgress,
  deployedConfigProblems,
  evidenceProblems,
  existingDeploymentSettled,
  parseToolOutput,
  publicUrl,
  redactValues,
  workerStartupVerdict,
} from './ai-cloudrun-deploy-plan.mjs';
import { buildCloudRunServiceDefs } from './cloudrun-service-manifest.mjs';

function settings(overrides = {}) {
  return {
    TCB_ENV_ID: 'env-fixture',
    APP_ENV: 'test',
    AI_VPC_ID: 'vpc-fixture1',
    AI_CLOUDRUN_SUBNET_ID: 'subnet-fixture1',
    CORS_ALLOWED_ORIGINS: 'https://site.example',
    DATABASE_URL: 'postgres://app:db-password-fixture@10.0.0.3:5432/ai',
    KB_API_KEY: 'kb-key-fixture-0123456789',
    AI_IP_HASH_SECRET: 'hash-secret-fixture-0123456789',
    AI_ENGINE_ID: 'anythingllm',
    AI_ENGINE_VERSION: '1.9.0',
    AI_ENGINE_PROVENANCE_KIND: 'git',
    AI_ENGINE_GIT_COMMIT: 'a'.repeat(40),
    AI_ENGINE_GIT_REPOSITORY: 'https://git.example/kb.git',
    AI_ENGINE_CONFIG_DIGEST: 'b'.repeat(64),
    AI_TRUST_PROXY: 'true',
    AI_PROFILE_ID: 'channel-public-v1',
    AI_WORKER_LEASE_SECONDS: '90',
    AI_MAX_STREAM_DURATION_MS: '55000',
    AI_MAX_OUTPUT_TOKENS: '4096',
    AI_MAX_TOOL_CALLS: '0',
    KB_BASE_URL: 'https://kb.example',
    KB_WORKSPACE_SLUG: 'channel',
    KB_WORKSPACE_ID: '7',
    AI_KNOWLEDGE_CREDENTIAL_ID: 'cred-fixture',
    KB_CITATIONS_VERIFIED: 'true',
    KB_CREDENTIAL_ROTATION: '3',
    AI_CORPUS_GENERATION: '1789438268931',
    AI_KB_EVIDENCE_JSON: '{"schema":"channel.ai.kb-evidence/2"}',
    AI_APPROVED_SOURCE_PREFIX: 'channelkb',
    AI_SITE_ORIGIN: 'https://site.example',
    ...overrides,
  };
}

/** A proof shaped exactly like the one scripts/probe-anythingllm.mjs writes. */
function evidence(overrides = {}) {
  return {
    schema: 'channel.ai.kb-evidence/2',
    recordedAt: new Date().toISOString(),
    credentialId: 'cred-fixture',
    workspaceSlug: 'channel',
    workspaceId: 7,
    rotationCounter: 3,
    corpusGeneration: '1789438268931',
    positiveControl: {
      retrieved: true,
      resultCount: 4,
      approvedSourceCount: 2,
      citationsObserved: 2,
    },
    generationControl: {
      sync: { ok: true, citationCount: 2 },
      stream: { ok: true, citationCount: 1 },
    },
    toolSurface: { inspected: true, enabledCount: 0, verdict: 'none' },
    transport: { https: true, insecureOverride: false },
    ...overrides,
  };
}

/** What `queryCloudRun detail` reports for a service deployed exactly as planned. */
function deployedConfig(def, overrides = {}) {
  return {
    VpcConf: { VpcId: def.vpc.vpcId, SubnetId: def.vpc.subnetId },
    OpenAccessTypes: def.publicAccess ? ['PUBLIC'] : ['VPC'],
    // detail masks every value but keeps the keys.
    EnvParams: JSON.stringify(
      Object.fromEntries(Object.keys(def.envVariables).map((key) => [key, '***'])),
    ),
    Port: def.containerPort,
    MinNum: def.minNum,
    MaxNum: def.maxNum,
    PublicNetConf: { PublicNetStatus: 'ENABLE' },
    ...overrides,
  };
}

const [bff, worker] = buildCloudRunServiceDefs(deployContextFromEnv(settings()));

test('the BFF is deployed public, the worker private, and both join the database VPC', () => {
  const bffArgs = cloudRunDeployArgs(bff, '/stage/ai-bff');
  const workerArgs = cloudRunDeployArgs(worker, '/stage/ai-worker');
  assert.deepEqual(bffArgs.serverConfig.OpenAccessTypes, ['PUBLIC']);
  // VPC-only: reachable from inside the private network, never from the internet.
  assert.deepEqual(workerArgs.serverConfig.OpenAccessTypes, ['VPC']);
  for (const args of [bffArgs, workerArgs]) {
    assert.deepEqual(args.serverConfig.VpcConf, {
      VpcId: 'vpc-fixture1',
      SubnetId: 'subnet-fixture1',
    });
  }
});

test('a deploy replaces the whole environment, so no removed or hand-added setting lingers', () => {
  const args = cloudRunDeployArgs(bff, '/stage/ai-bff');
  assert.equal(args.envParamsReplaceAll, true);
  assert.deepEqual(JSON.parse(args.serverConfig.EnvParams), bff.envVariables);
});

test('CloudRun builds a container from the staged copy, sized as the manifest says', () => {
  const args = cloudRunDeployArgs(worker, '/stage/ai-worker');
  assert.equal(args.action, 'deploy');
  assert.equal(args.serverName, 'ai-worker');
  assert.equal(args.serverType, 'container');
  assert.equal(args.targetPath, '/stage/ai-worker');
  // The staged copy carries the service's Dockerfile at its root.
  assert.equal(args.serverConfig.Dockerfile, 'Dockerfile');
  assert.equal(args.serverConfig.Port, worker.containerPort);
  const { Cpu, Mem, MinNum, MaxNum } = args.serverConfig;
  assert.deepEqual(
    [Cpu, Mem, MinNum, MaxNum],
    [worker.cpu, worker.mem, worker.minNum, worker.maxNum],
  );
  assert.throws(() => cloudRunDeployArgs(worker, 'stage/ai-worker'), /absolute/);
});

test('a missing setting says whether it is a GitHub secret or a GitHub variable', () => {
  assert.throws(
    () => buildCloudRunServiceDefs(deployContextFromEnv(settings({ DATABASE_URL: undefined }))),
    /DATABASE_URL.*GitHub secret/,
  );
  assert.throws(
    () => buildCloudRunServiceDefs(deployContextFromEnv(settings({ AI_PROFILE_ID: ' ' }))),
    /AI_PROFILE_ID.*GitHub variable/,
  );
  assert.throws(() => deployContextFromEnv(settings({ AI_VPC_ID: undefined })), /AI_VPC_ID/);
  assert.throws(
    () => deployContextFromEnv(settings({ CORS_ALLOWED_ORIGINS: '' })),
    /CORS_ALLOWED_ORIGINS/,
  );
});

test('the knowledge-base proof must match what the worker will check it against', () => {
  // The worker refuses to start on a mismatch. Checking here turns a worker
  // that silently never starts into a failed deploy that says why.
  assert.deepEqual(evidenceProblems(evidence(), settings()), []);
  const problems = (overrides) => evidenceProblems(evidence(overrides), settings()).join('\n');
  assert.match(problems({ credentialId: 'another-key' }), /credential/);
  assert.match(problems({ workspaceId: 8 }), /workspace id/);
  assert.match(problems({ corpusGeneration: '1' }), /corpus generation/);
  assert.match(problems({ rotationCounter: 4 }), /rotation/);
});

test('a proof older than an hour is refused, so every deploy ships a fresh one', () => {
  // The worker accepts a proof for 30 days from when it was recorded. A deploy
  // that shipped an old one would leave the service fewer days before a
  // restarted instance refuses to start.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  assert.match(
    evidenceProblems(evidence({ recordedAt: twoHoursAgo }), settings()).join('\n'),
    /older than/,
  );
});

test('only folders the Docker build already ignores are left out of the upload', () => {
  // Leaving them out saves uploading ~50 MB of site media and docs. That is only
  // safe because the image never contained them; this keeps it that way.
  const rules = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  assert.ok(STAGING_EXCLUDES.length > 0);
  for (const path of STAGING_EXCLUDES) {
    assert.ok(rules.includes(path), `${path} is left out of the upload but not out of the image`);
  }
});

test('a deploy is not finished while the service still shows the previous deployment', () => {
  const progress = (latestDeploy) =>
    deployProgress({ latestDeploy }, { previousDeployId: '001' }).state;
  assert.equal(progress({ DeployId: '001', Status: 'normal', IsReleasing: false }), 'pending');
  assert.equal(progress({ DeployId: '002', Status: 'building', IsReleasing: true }), 'pending');
  assert.equal(progress({ DeployId: '002', Status: 'normal', IsReleasing: true }), 'pending');
  assert.equal(progress({ DeployId: '002', Status: 'normal', IsReleasing: false }), 'succeeded');
  assert.equal(
    progress({ DeployId: '002', Status: 'deploy_failed', IsReleasing: false }),
    'failed',
  );
  assert.equal(progress(undefined), 'pending');
  // A brand-new service has no previous deployment to confuse it with.
  assert.equal(
    deployProgress(
      { latestDeploy: { DeployId: '001', Status: 'normal', IsReleasing: false } },
      { previousDeployId: null },
    ).state,
    'succeeded',
  );
  // A first deploy can fail before it leaves a record; the service itself says so.
  const failedService = { service: { BaseInfo: { Status: 'deploy_failed' } } };
  assert.equal(deployProgress(failedService, { previousDeployId: null }).state, 'failed');
});

test("the BFF's public address is the HTTPS one CloudRun assigned", () => {
  const detail = (url) => ({ service: { BaseInfo: { DefaultDomainName: url } } });
  assert.equal(
    publicUrl(detail('https://ai-bff-298020-11-1.sh.run.tcloudbase.com/')),
    'https://ai-bff-298020-11-1.sh.run.tcloudbase.com',
  );
  assert.throws(() => publicUrl(detail('')), /no HTTPS address/);
  assert.throws(() => publicUrl(detail('http://ai-bff.example')), /no HTTPS address/);
});

test('the deployed configuration is read back and compared with the manifest', () => {
  assert.deepEqual(deployedConfigProblems(bff, deployedConfig(bff)), []);
  assert.deepEqual(deployedConfigProblems(worker, deployedConfig(worker)), []);
  const problems = (def, overrides) =>
    deployedConfigProblems(def, deployedConfig(def, overrides)).join('\n');
  assert.match(problems(worker, { OpenAccessTypes: ['VPC', 'PUBLIC'] }), /internet/);
  assert.match(problems(bff, { VpcConf: { VpcId: '', SubnetId: '' } }), /VPC/);
  const leftover = JSON.stringify({
    ...JSON.parse(deployedConfig(bff).EnvParams),
    AI_LOCAL_HARNESS: '***',
  });
  assert.match(problems(bff, { EnvParams: leftover }), /AI_LOCAL_HARNESS/);
  assert.match(problems(bff, { MinNum: 0 }), /MinNum/);
  // The worker calls the knowledge base on the internet through CloudRun's
  // default exit. With that switched off it would need a NAT gateway.
  assert.match(problems(worker, { PublicNetConf: { PublicNetStatus: 'DISABLE' } }), /NAT/);
});

test('secret values never reach the log, whether plain or JSON-escaped', () => {
  const secret = 'postgres://app:p"w\\d@10.0.0.3:5432/ai';
  const once = JSON.stringify(secret);
  const twice = JSON.stringify(JSON.stringify({ DATABASE_URL: secret }));
  const redacted = redactValues(`a ${secret} b ${once} c ${twice}`, [secret, '', undefined]);
  assert.ok(!redacted.includes('10.0.0.3:5432/ai'), redacted);
  assert.ok(!redacted.includes('p"w'), redacted);
  assert.equal(redactValues('nothing secret here', ['true']), 'nothing secret here');
});

test('an existing cloud deployment must settle before another upload starts', () => {
  const detail = (Status, IsReleasing = false) => ({ latestDeploy: { Status, IsReleasing } });
  assert.equal(existingDeploymentSettled(detail('normal')), true);
  assert.equal(existingDeploymentSettled(detail('deploy_failed')), true);
  assert.equal(existingDeploymentSettled(detail('normal', true)), false);
  assert.equal(existingDeploymentSettled(detail('building')), false);
  assert.equal(existingDeploymentSettled(detail('unknown')), false);
  assert.equal(existingDeploymentSettled({}), false);
});

test('MCP issue links redact URL-encoded settings, including nested JSON', () => {
  const secret = 'postgres://app:fake-password@10.0.0.3:5432/ai?sslmode=verify-full';
  const body = JSON.stringify({ EnvParams: JSON.stringify({ DATABASE_URL: secret }) });
  for (const encoded of [encodeURIComponent(body), encodeURIComponent(encodeURIComponent(body))]) {
    const redacted = redactValues(`https://example.com/issues/new?body=${encoded}`, [secret]);
    assert.ok(!redacted.includes('fake-password'), 'encoded secret survived redaction');
  }
});

test("the worker's start-up state is the last thing it logged", () => {
  const line = (event, level = 'error') => JSON.stringify({ level, event, code: null });
  const verdict = (lines) => workerStartupVerdict(lines).verdict;
  assert.equal(
    verdict([line('knowledge_base_unreachable'), line('knowledge_base_unreachable')]),
    'knowledge_base_unreachable',
  );
  assert.equal(
    verdict([line('knowledge_base_unreachable'), `2026-09-15 ${line('database_unavailable')}`]),
    'database_unavailable',
  );
  assert.equal(verdict([line('database_unavailable'), line('worker_started', 'info')]), 'started');
  assert.equal(verdict(['2026-09-15 01:06:02 check_eks_virtual_service : succ']), 'unknown');
});

test('tool output is read past any banner the tool prints first', () => {
  assert.deepEqual(parseToolOutput('npx: installed 1\n{"success":true}'), { success: true });
  assert.throws(() => parseToolOutput('no json at all'), /No JSON/);
});
