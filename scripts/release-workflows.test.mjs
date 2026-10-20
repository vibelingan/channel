import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { runStaticCanary } from './run-static-canary.mjs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const policy = JSON.parse(read('scripts/release/static-canary-policy.json'));
const workflow = parse(read('.github/workflows/seo-static-canary.yml'));
test('canary is manual only, shares target lock, and cannot cancel existing deployment', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const deploy = parse(read('.github/workflows/deploy-test.yml'));
  assert.deepEqual(workflow.concurrency, deploy.concurrency);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.canary.environment, 'test');
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.equal(policy.enabled, false);
  assert.equal(policy.controlPlaneReviewSha256, null);
});
test('manual workflow archives payload before execution and scopes credentials only to entrypoint steps', () => {
  const steps = workflow.jobs.canary.steps;
  const archive = steps.findIndex((s) => s.id === 'payload');
  const execute = steps.findIndex((s) => s.run === 'node scripts/run-static-canary.mjs run');
  assert.ok(archive > 0 && execute > archive);
  assert.equal(steps[archive].with['if-no-files-found'], 'error');
  assert.equal(steps[archive].with['retention-days'], 90);
  assert.equal(workflow.jobs.canary.env.TENCENTCLOUD_SECRETKEY, undefined);
  const cloudSteps = steps.filter((s) => s.env?.TENCENTCLOUD_SECRETKEY);
  assert.equal(cloudSteps.length, 2);
  assert.ok(cloudSteps.every((s) => /^node scripts\/run-static-canary.mjs /.test(s.run)));
  assert.ok(steps.some((s) => s.run === 'pnpm install --frozen-lockfile --ignore-scripts'));
  assert.ok(!steps.some((s) => /deploy-cloudbase|build|pnpm test|catalog/.test(s.run ?? '')));
  const serialized = JSON.stringify(steps.filter((s) => s.run).map((s) => s.run));
  assert.ok(!serialized.includes('${{ inputs.'));
});
test('disabled live CLI fails before requesting tokens, cloud credentials or SDK network', async () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: policy.repository,
    GITHUB_REF: policy.trustedRef,
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '101',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'canary',
    CANARY_MODE: 'execute',
    CANARY_ACTION: 'initialize',
  };
  await assert.rejects(runStaticCanary('prepare', env), /disabled/);
});
