import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

// These inspect the scheduler's input graph, not source text or a homemade
// Actions runner. GitHub owns needs/success semantics; no cloud jobs run here.
function assertReleaseGate(ci, release) {
  assert.ok(Object.hasOwn(ci.on, 'workflow_call'), 'CI must be callable by the deploy graph');
  const prerequisite = release.jobs.ci;
  assert.ok(prerequisite, 'deploy must run the full CI prerequisite');
  assert.equal(prerequisite.uses, './.github/workflows/ci.yml', 'reuse CI at the caller SHA');
  assert.equal(prerequisite.secrets, undefined, 'full CI does not need deployment secrets');
  assert.equal(prerequisite['continue-on-error'], undefined);
  const deploy = release.jobs.deploy;
  assert.deepEqual([deploy.needs].flat(), ['ci']);
  assert.equal(deploy.if, "${{ github.ref == 'refs/heads/test' && needs.ci.result == 'success' }}");
  assert.equal(deploy['continue-on-error'], undefined);
  assert.equal(deploy.environment, 'test');
  assert.equal(release.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(release.concurrency['cancel-in-progress'], false);
  for (const job of [ci.jobs.checks, deploy]) {
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(
      checkout?.with?.ref,
      '${{ github.sha }}',
      'build the triggering SHA, not branch HEAD',
    );
  }
  assert.equal(ci.jobs.checks.if, undefined);
  assert.equal(ci.jobs.checks['continue-on-error'], undefined);
  for (const command of [
    'pnpm verify:cloudbase-sdk',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'pnpm package:functions',
    'pnpm build',
    'pnpm test:e2e --list',
    'pnpm exec playwright install --with-deps chromium',
    'pnpm test:e2e:catalog-admin-local',
  ]) {
    const step = ci.jobs.checks.steps.find((candidate) => candidate.run === command);
    assert.ok(step, `full CI is missing ${command}`);
    assert.equal(step.if, undefined, `${command} must not be optional`);
    assert.equal(step['continue-on-error'], undefined, `${command} must fail closed`);
  }
}

test('push and manual deployments require same-SHA full CI before entering the environment', () => {
  const ci = workflow('ci');
  const release = workflow('deploy-test');
  assertReleaseGate(ci, release);
  assert.deepEqual(release.on.push.branches, ['test']);
  assert.ok(Object.hasOwn(release.on, 'workflow_dispatch'));
  // No separate dispatch-only job or alternate writer can bypass the gate.
  assert.deepEqual(Object.keys(release.jobs).sort(), ['ci', 'deploy']);
});

test('release guard detects missing dependencies, success bypass, moving refs and softened tests', () => {
  const ci = workflow('ci');
  const release = workflow('deploy-test');
  assertReleaseGate(ci, release);
  for (const mutate of [
    (_ci, candidate) => {
      candidate.jobs.deploy.needs = undefined;
    },
    (_ci, candidate) => {
      candidate.jobs.deploy.if = '${{ always() }}';
    },
    (_ci, candidate) => {
      candidate.jobs.ci.uses = './.github/workflows/ci.yml@main';
    },
    (_ci, candidate) => {
      candidate.jobs.deploy.steps[0].with.ref = 'test';
    },
    (candidate) => {
      candidate.jobs.checks['continue-on-error'] = true;
    },
    (candidate) => {
      candidate.jobs.checks.steps.find((step) => step.run === 'pnpm test').if = 'false';
    },
    (candidate) => {
      candidate.jobs.checks.steps.find((step) => step.run === 'pnpm test').run =
        'pnpm test:deploy-smoke';
    },
    (candidate) => {
      candidate.jobs.checks.steps.find((step) => step.run === 'pnpm test:e2e:catalog-admin-local')[
        'continue-on-error'
      ] = true;
    },
    (candidate) => {
      candidate.jobs.checks.steps.find(
        (step) => step.run === 'pnpm test:e2e:catalog-admin-local',
      ).run = 'pnpm test:e2e --list';
    },
  ]) {
    const mutatedCi = structuredClone(ci);
    const mutatedRelease = structuredClone(release);
    mutate(mutatedCi, mutatedRelease);
    assert.throws(() => assertReleaseGate(mutatedCi, mutatedRelease));
  }
});

test('both package producers smoke the exact release on the deployed Node 20 runtime', () => {
  for (const job of [workflow('ci').jobs.checks, workflow('deploy-test').jobs.deploy]) {
    let nodeVersion;
    let packaged = false;
    let smoked = false;
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/setup-node@')) nodeVersion = step.with['node-version'];
      if (step.run === 'pnpm package:functions') packaged = true;
      if (step.run === 'node scripts/smoke-function-artifacts.mjs') {
        assert.equal(packaged, true);
        assert.equal(String(nodeVersion), '20.19.0');
        assert.equal(step.env?.CHANNEL_EXPECTED_RELEASE, '${{ github.sha }}');
        assert.equal(step.if, undefined);
        assert.equal(step['continue-on-error'], undefined);
        smoked = true;
      }
      if (step.run === 'pnpm build') {
        assert.equal(smoked, true, 'site build follows packaged runtime validation');
        assert.equal(String(nodeVersion), '22.13.0', 'restore the supported site build runtime');
      }
    }
    assert.equal(smoked, true, 'packaged runtime check must execute');
  }
});
