/**
 * The AI CloudRun deploy workflow must deploy only a commit whose tests passed,
 * give the deploy every setting it reads, and give each secret only to the
 * steps that use it.
 *
 * Each of these fails silently otherwise. A deploy that does not wait for tests
 * ships a failing commit whenever someone tags one. A setting added to the
 * manifest but not to the workflow is found by a live deploy stopping on
 * "Missing <setting>", after the probe already ran against the production
 * knowledge base.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { GITHUB_SECRETS, deployContextFromEnv } from './ai-cloudrun-deploy-plan.mjs';
import { buildCloudRunServiceDefs } from './cloudrun-service-manifest.mjs';

const readWorkflow = (file) =>
  parseYaml(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
const workflow = readWorkflow('deploy-ai-cloudrun.yml');
const verify = workflow.jobs?.verify;
const deploy = workflow.jobs?.deploy;

test('the infrastructure MCP can access staged builds from the repository root', () => {
  const configPath = fileURLToPath(new URL('../config/mcporter.infra.json', import.meta.url));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // mcporter 0.13.13 resolves stdio cwd relative to the CONFIG directory.
  // --root controls discovery, not the spawned server's filesystem boundary.
  const serverCwd = resolve(dirname(configPath), config.mcpServers.cloudbase.cwd ?? '.');
  assert.equal(serverCwd, resolve(dirname(configPath), '..'));
});

test('the MCP upload deadline is explicit and shorter than its enclosing process deadline', () => {
  const script = readFileSync(new URL('./deploy-ai-cloudrun.mjs', import.meta.url), 'utf8');
  assert.match(script, /'--timeout',\s*String\(MCP_CALL_TIMEOUT_MS\)/);
  const timeout = Number(
    script.match(/const MCP_CALL_TIMEOUT_MS = ([\d_]+)/)?.[1].replaceAll('_', ''),
  );
  assert.ok(timeout >= 180_000 && timeout < 300_000);
});

test('inspection tags query existing services without uploading or probing the KB', () => {
  assert.match(deploy.env.AI_CLOUDRUN_INSPECT_ONLY, /ai-cloudrun-deploy-inspect-/);
  assert.equal(
    stepRunning(deploy, 'node scripts/probe-anythingllm.mjs').if,
    "env.AI_CLOUDRUN_INSPECT_ONLY != '1'",
  );
  const script = readFileSync(new URL('./deploy-ai-cloudrun.mjs', import.meta.url), 'utf8');
  const inspect = script
    .split("if (env.AI_CLOUDRUN_INSPECT_ONLY === '1') {")[1]
    ?.split('const ctx =')[0];
  assert.ok(inspect?.includes('serviceDetail(name)'));
  assert.ok(inspect?.includes('return;'));
  assert.ok(!inspect?.includes("callTool('manageCloudRun'"));
});

/**
 * The one step in a job whose command is exactly this. Exact, not a prefix:
 * `pnpm test` must not be satisfied by a step that runs `pnpm test:ai`.
 */
function stepRunning(job, command) {
  const matches = job.steps.filter((step) => step.run?.trim() === command);
  assert.equal(matches.length, 1, `expected exactly one step running ${command}`);
  return matches[0];
}

/** Every setting the deploy reads, for both kinds of engine provenance. */
function settingsTheDeployReads() {
  const names = new Set(['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY']);
  for (const kind of ['git', 'oci']) {
    const values = { AI_VPC_ID: 'vpc-a', AI_CLOUDRUN_SUBNET_ID: 'subnet-a' };
    const recording = new Proxy(
      {},
      {
        get(_, name) {
          names.add(name);
          if (name === 'AI_ENGINE_PROVENANCE_KIND') return kind;
          return values[name] ?? 'value';
        },
      },
    );
    buildCloudRunServiceDefs(deployContextFromEnv(recording));
  }
  // The deploy writes this itself, from the file the probe step records.
  names.delete('AI_KB_EVIDENCE_JSON');
  return names;
}

test('nothing is deployed until the commit has passed lint, typecheck and every test', () => {
  assert.deepEqual([deploy.needs].flat(), ['verify']);
  for (const command of ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm test:ai']) {
    stepRunning(verify, command);
  }
  // The AI store, BFF and worker tests need a real database; the job brings one.
  assert.equal(verify.services?.postgres?.image, 'postgres:16');
});

test('the deploy step is given every setting the deploy reads, from the right store', () => {
  const deployStep = stepRunning(deploy, 'pnpm deploy:ai:cloudrun');
  const given = { ...deploy.env, ...deployStep.env };
  for (const name of settingsTheDeployReads()) {
    assert.ok(given[name], `the workflow does not pass ${name} to the deploy`);
    const store = GITHUB_SECRETS.has(name) ? 'secrets' : 'vars';
    assert.match(
      String(given[name]),
      new RegExp(`^\\$\\{\\{ ${store}\\.${name}\\b`),
      `${name} must come from ${store}.${name}`,
    );
  }
});

test('secrets are handed only to the steps that use them', () => {
  // The test job runs every test in the repository, so it gets no secrets and
  // no access to the environment that holds them.
  assert.equal(verify.environment, undefined, 'the test job can reach the test environment');
  assert.ok(!JSON.stringify(verify).includes('secrets.'), 'the test job is given a secret');
  assert.ok(!JSON.stringify(deploy.env).includes('secrets.'), 'job-wide settings carry a secret');

  const probe = stepRunning(deploy, 'node scripts/probe-anythingllm.mjs');
  const deployStep = stepRunning(deploy, 'pnpm deploy:ai:cloudrun');
  const probeSecrets = Object.values(probe.env ?? {}).filter((value) =>
    String(value).includes('secrets.'),
  );
  assert.equal(probeSecrets.length, 1, 'the probe needs the knowledge-base key and nothing else');
  assert.match(probeSecrets[0], /secrets\.KB_API_KEY\b/);
  for (const step of deploy.steps) {
    if (step === probe || step === deployStep) continue;
    assert.ok(!JSON.stringify(step).includes('secrets.'), `${step.name} is given a secret`);
  }
});

test('the knowledge base is proven before the services change, and the proof reaches the deploy', () => {
  const probe = stepRunning(deploy, 'node scripts/probe-anythingllm.mjs');
  const deployStep = stepRunning(deploy, 'pnpm deploy:ai:cloudrun');
  assert.ok(deploy.steps.indexOf(probe) < deploy.steps.indexOf(deployStep));
  assert.ok(probe.env?.AI_KB_EVIDENCE_FILE, 'the probe is not asked to record its proof');
  assert.equal(deployStep.env?.AI_KB_EVIDENCE_FILE, probe.env.AI_KB_EVIDENCE_FILE);
});

test('it deploys only on purpose, and one CloudBase change at a time', () => {
  assert.equal(deploy.environment, 'test');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  // A deploy starts from a deploy tag or by hand, never from an ordinary push.
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { tags: ['ai-cloudrun-deploy-*'] });
  // Deploy Test changes the same CloudBase environment; the two must queue.
  assert.equal(workflow.concurrency.group, readWorkflow('deploy-test.yml').concurrency.group);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});
