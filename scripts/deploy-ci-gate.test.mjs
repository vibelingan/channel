import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('live acceptance probes sync HTTP health rather than an unsupported POST action', () => {
  const source = readFileSync(
    new URL('../tests/e2e/catalog-live-acceptance.spec.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /request\.get\(`\$\{e2e\.apiUrl\}\/api\/alibaba-catalog-sync\/health`\)/);
  assert.doesNotMatch(source, /sync\(['"]health['"]\)/);
});

test('normal deployment awaits hosted asset integrity before pruning or declaring success', () => {
  const source = readFileSync(new URL('./deploy-cloudbase-test.mjs', import.meta.url), 'utf8');
  assert.match(source, /const assets = hostedAssetManifest\(distPath\)/);
  assert.match(source, /await publishVerifiedAssets\(/);
  assert.match(source, /verify: \(\) => verifyHostedAssets\(assets, siteUrl\)/);
  assert.ok(
    source.indexOf('await publishVerifiedAssets(') <
      source.lastIndexOf('pruneLegacyHostingPaths();'),
  );
  assert.match(source, /await deployWebApp\(\)/);
});

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
  assert.equal(
    deploy.if,
    "${{ github.ref == 'refs/heads/test' && needs.ci.result == 'success' && github.event.inputs.catalog_acceptance_only != 'true' }}",
  );
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
  ]) {
    const step = ci.jobs.checks.steps.find((candidate) => candidate.run === command);
    assert.ok(step, `full CI is missing ${command}`);
    assert.equal(step.if, undefined, `${command} must not be optional`);
    assert.equal(step['continue-on-error'], undefined, `${command} must fail closed`);
  }
  for (const formal of [false, true]) {
    const step = ci.jobs.checks.steps.find(
      (candidate) =>
        candidate.run === 'pnpm test:e2e:catalog-admin-local' &&
        (candidate.env?.E2E_CATALOG_FORMAL === '1') === formal,
    );
    assert.ok(step, `Missing ${formal ? 'formal inquiry' : 'legacy catalog'} browser lane`);
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
  }
}

test('push and manual deployments require same-SHA full CI before entering the environment', () => {
  const ci = workflow('ci');
  const release = workflow('deploy-test');
  assertReleaseGate(ci, release);
  assert.deepEqual(release.on.push.branches, ['test']);
  assert.ok(Object.hasOwn(release.on, 'workflow_dispatch'));
  assert.deepEqual(Object.keys(release.jobs).sort(), ['catalog-acceptance', 'ci', 'deploy']);
});

test('acceptance-only dispatch cannot deploy and cannot bypass CI or use infrastructure credentials', () => {
  const release = workflow('deploy-test');
  const job = release.jobs['catalog-acceptance'];
  assert.equal(release.on.workflow_dispatch.inputs.catalog_acceptance_only.default, false);
  assert.deepEqual(release.on.workflow_dispatch.inputs.catalog_acceptance_scope.options, [
    'full',
    'variant-media',
  ]);
  assert.equal(job.needs, 'ci');
  assert.equal(
    job.if,
    "${{ github.ref == 'refs/heads/test' && needs.ci.result == 'success' && github.event.inputs.catalog_acceptance_only == 'true' }}",
  );
  assert.equal(job.environment, 'test');
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
  const step = job.steps.find(
    (s) => s.run === 'pnpm exec playwright test tests/e2e/catalog-live-acceptance.spec.ts',
  );
  assert.ok(step);
  assert.equal(step.env.CHANNEL_EXPECTED_RELEASE, '${{ github.sha }}');
  assert.equal(step.env.E2E_RECORD_ARTIFACTS, '0');
  assert.equal(
    step.env.E2E_CATALOG_ACCEPTANCE_SCOPE,
    "${{ github.event.inputs.catalog_acceptance_scope || 'full' }}",
  );
  assert.equal(step['continue-on-error'], undefined);
  assert.doesNotMatch(
    JSON.stringify(job),
    /TENCENTCLOUD_|JWT_SECRET|SMTP|EMAIL_PASSWORD|deploy:cloudbase|deploy-cloudbase/,
  );
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
    (candidate) => {
      candidate.jobs.checks.steps.find(
        (step) => step.env?.E2E_CATALOG_FORMAL === '1',
      ).env.E2E_CATALOG_FORMAL = '0';
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
