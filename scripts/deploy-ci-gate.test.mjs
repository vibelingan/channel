import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

function assertSharedEnvironmentLock(release, e2e) {
  for (const candidate of [release, e2e]) {
    assert.deepEqual(candidate.concurrency, {
      group: 'cloudbase-deploy-test',
      'cancel-in-progress': false,
      queue: 'max',
    });
  }
  assert.equal(e2e.jobs.e2e.environment, release.jobs.deploy.environment);
  assert.equal(e2e.jobs.e2e.environment, release.jobs['catalog-acceptance'].environment);
}

test('all dispatched E2E suites share the deployment and acceptance environment lock', () => {
  assertSharedEnvironmentLock(workflow('deploy-test'), workflow('e2e'));
});

test('environment lock regression detects suite/ref partitioning and cancellation', () => {
  const release = workflow('deploy-test');
  const e2e = workflow('e2e');
  e2e.concurrency = structuredClone(release.concurrency);
  assertSharedEnvironmentLock(release, e2e);
  for (const group of [
    'e2e-${{ github.workflow }}-${{ inputs.suite }}',
    'cloudbase-deploy-${{ github.ref }}',
    'cloudbase-deploy-${{ vars.TCB_ENV_ID }}',
  ]) {
    for (const candidate of ['release', 'e2e']) {
      const workflows = { release: structuredClone(release), e2e: structuredClone(e2e) };
      workflows[candidate].concurrency.group = group;
      assert.throws(() => assertSharedEnvironmentLock(workflows.release, workflows.e2e));
    }
  }
  for (const candidate of ['release', 'e2e']) {
    const workflows = { release: structuredClone(release), e2e: structuredClone(e2e) };
    workflows[candidate].concurrency['cancel-in-progress'] = true;
    assert.throws(() => assertSharedEnvironmentLock(workflows.release, workflows.e2e));
  }
});

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

test('deployment captures one explicit public snapshot and retains recovery inputs before cloud mutation', () => {
  const steps = workflow('deploy-test').jobs.deploy.steps;
  const capture = steps.findIndex((step) => step.name === 'Capture public product snapshot');
  const build = steps.findIndex((step) => step.run === 'pnpm build');
  const archive = steps.findIndex(
    (step) => step.name === 'Preserve accepted site recovery inputs before deployment',
  );
  const deploy = steps.findIndex((step) => step.run === 'pnpm deploy:cloudbase:test');
  assert.ok(capture >= 0 && capture < build && build < archive && archive < deploy);
  // The read-only backup runs beside CI; the deploy job restores it and proves it current
  // immediately before its first write.
  const prepare = workflow('deploy-test').jobs.prepare.steps;
  const backup = prepare.findIndex(
    (step) => step.name === 'Capture the current hosted site before cloud mutation',
  );
  const preserveBackup = prepare.findIndex(
    (step) => step.name === 'Preserve the verified pre-deployment hosting backup',
  );
  assert.ok(backup >= 0 && backup < preserveBackup);
  assert.equal(
    prepare[backup].run,
    'node scripts/capture-hosting-backup.mjs --output output/hosting-backup-before',
  );
  assert.equal(prepare[preserveBackup].with['if-no-files-found'], 'error');
  assert.equal(prepare[preserveBackup].with['include-hidden-files'], true);
  const restore = steps.findIndex(
    (step) => step.name === 'Restore the hosted-site backup taken beside CI',
  );
  const current = steps.findIndex(
    (step) => step.name === 'Confirm the live site still matches that backup before cloud mutation',
  );
  const functions = steps.findIndex((step) =>
    step.run?.startsWith('node scripts/capture-function-backups.mjs'),
  );
  assert.ok(archive < restore && restore < current && current < functions && functions < deploy);
  assert.equal(steps[restore].with.name, prepare[preserveBackup].with.name);
  assert.equal(
    steps[current].run,
    'node scripts/verify-hosting-backup-current.mjs --backup output/hosting-backup-before',
  );
  for (const step of [prepare[backup], prepare[preserveBackup], steps[restore], steps[current]]) {
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
  }
  assert.match(steps[capture].run, /prepare-products.ts/);
  assert.deepEqual(workflow('deploy-test').on.workflow_dispatch.inputs.product_source.options, [
    'fresh',
    'accepted',
  ]);
  assert.equal(
    workflow('deploy-test').jobs.deploy.env.SITE_PRODUCT_SOURCE,
    "${{ github.event.inputs.product_source || 'fresh' }}",
  );
  assert.ok(steps[capture].env.SEO_CATALOG_API_ORIGIN);
  assert.equal(
    steps[build].env.SEO_CATALOG_SNAPSHOT,
    '${{ github.workspace }}/output/seo-release/product-snapshot.json',
  );
  assert.equal(steps[build].env.SEO_CATALOG_API_ORIGIN, undefined);
  assert.equal(steps[archive].with['if-no-files-found'], 'error');
  assert.match(steps[archive].with.path, /apps\/site\/dist\//);
  for (const step of [steps[capture], steps[build], steps[archive]]) {
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
  }
  const audit = steps.findIndex(
    (step) => step.name === 'Verify ordinary hosting URLs and error document',
  );
  assert.ok(audit > deploy);
  assert.match(steps[audit].run, /--dist apps\/site\/dist/);
  assert.equal(steps[audit].if, undefined);
  assert.equal(steps[audit]['continue-on-error'], undefined);
  const source = readFileSync(new URL('./deploy-cloudbase-test.mjs', import.meta.url), 'utf8');
  assert.ok(
    source.indexOf('hostingContractHashes(resolve(siteRootPath') <
      source.indexOf("callTool('cloudbase.auth'"),
  );
  const preflight = source.indexOf('await auditHostingContract(siteUrl, { cacheOnly: true })');
  assert.ok(preflight > 0 && preflight < source.indexOf("callTool('cloudbase.auth'"));
  assert.match(source, /if \(!hostingBefore\.passed\) \{\s*throw new Error/);
  assert.match(source, /\.\.\.WEBSITE_DOCUMENTS/);
});

// These inspect the scheduler's input graph, not source text or a homemade
// Actions runner. GitHub owns needs/success semantics; no cloud jobs run here.
function assertReleaseGate(ci, release) {
  assert.ok(Object.hasOwn(ci.on, 'workflow_call'), 'CI must be callable by the deploy graph');
  const prerequisite = release.jobs.ci;
  assert.ok(prerequisite, 'deploy must run the same-SHA code checks');
  assert.equal(
    prerequisite.uses,
    './.github/workflows/seo-module-1.yml',
    'reuse complete checks at the caller SHA',
  );
  const complete = workflow('seo-module-1');
  assert.ok(Object.hasOwn(complete.on, 'workflow_call'));
  assert.equal(complete.jobs.ci.uses, './.github/workflows/ci.yml');
  assert.deepEqual(complete.jobs.ready.needs, ['ci', 'catalog', 'blog']);
  assert.equal(complete.jobs.ready.name, 'Required release checks');
  assert.equal(prerequisite.name, 'Verified source and browser checks');
  assert.equal(prerequisite.secrets, undefined, 'code checks do not need deployment secrets');
  assert.equal(prerequisite['continue-on-error'], undefined);
  const deploy = release.jobs.deploy;
  assert.deepEqual([deploy.needs].flat(), ['ci', 'renderer-archive', 'prepare']);
  // Preparation runs beside CI, so it may only read: every command is on this list.
  const prepare = release.jobs.prepare;
  assert.equal(prepare.needs, undefined);
  assert.equal(
    prepare.if,
    "${{ github.ref == 'refs/heads/test' && github.event.inputs.catalog_acceptance_only != 'true' }}",
  );
  assert.equal(prepare['continue-on-error'], undefined);
  assert.equal(prepare.environment, 'test');
  assert.deepEqual(
    prepare.steps.filter((step) => step.run).map((step) => step.run.split('\n')[0]),
    [
      'pnpm install --frozen-lockfile',
      'pnpm test:deploy-smoke',
      'if [ -z "$TENCENTCLOUD_SECRETID" ] || [ -z "$TENCENTCLOUD_SECRETKEY" ]; then',
      'node scripts/capture-hosting-backup.mjs --output output/hosting-backup-before',
    ],
  );
  for (const step of prepare.steps) assert.equal(step['continue-on-error'], undefined);
  const archive = release.jobs['renderer-archive'];
  assert.equal(archive.needs, 'ci');
  assert.equal(
    archive.if,
    "${{ github.ref == 'refs/heads/test' && needs.ci.result == 'success' && github.event.inputs.catalog_acceptance_only != 'true' }}",
  );
  assert.equal(archive.permissions, undefined);
  assert.equal(release.permissions.contents, 'read');
  assert.equal(archive['continue-on-error'], undefined);
  assert.equal(archive.environment, 'test');
  const setting = archive.steps.find((step) => step.id === 'catalog');
  assert(setting?.run, 'environment flag must be checked in an actual runner step');
  assert.equal(setting.if, undefined);
  assert.equal(setting['continue-on-error'], undefined);
  assert.equal(setting.env.CATALOG_SEO_RECORDING, "${{ vars.CATALOG_SEO_RECORDING || '0' }}");
  for (const step of archive.steps.filter((step) => step !== setting)) {
    assert.equal(step.if, "${{ steps.catalog.outputs.required == 'true' }}");
    assert.equal(step['continue-on-error'], undefined);
  }
  assert.equal(
    archive.steps.find((s) => s.uses?.startsWith('actions/checkout@')).with.ref,
    '${{ github.sha }}',
  );
  assert.equal(
    deploy.if,
    "${{ !cancelled() && github.ref == 'refs/heads/test' && needs.ci.result == 'success' && needs.prepare.result == 'success' && (needs['renderer-archive'].result == 'success' || needs['renderer-archive'].result == 'skipped') && github.event.inputs.catalog_acceptance_only != 'true' }}",
  );
  assert.equal(deploy['continue-on-error'], undefined);
  assert.equal(deploy.environment, 'test');
  assert.equal(release.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(release.concurrency['cancel-in-progress'], false);
  for (const job of [ci.jobs.checks, deploy, prepare]) {
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(
      checkout?.with?.ref,
      '${{ github.sha }}',
      'build the triggering SHA, not branch HEAD',
    );
  }
  assert.deepEqual([ci.jobs.checks.needs].flat(), ['unit']);
  assert.equal(ci.jobs.unit['continue-on-error'], undefined);
  const groups = ci.jobs.unit.strategy.matrix.include;
  assert.deepEqual(groups.map((group) => group.suite).sort(), [
    'packages',
    'scripts',
    'services',
    'site',
  ]);
  assert.ok(groups.every((group) => typeof group.command === 'string'));
  assert.equal(ci.jobs.checks.if, undefined);
  assert.equal(ci.jobs.checks['continue-on-error'], undefined);
  for (const command of [
    'pnpm verify:cloudbase-sdk',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm package:functions',
    'pnpm build',
    'pnpm test:e2e --list',
  ]) {
    const step = ci.jobs.checks.steps.find((candidate) => candidate.run === command);
    assert.ok(step, `full CI is missing ${command}`);
    assert.equal(step.if, undefined, `${command} must not be optional`);
    assert.equal(step['continue-on-error'], undefined, `${command} must fail closed`);
  }
  assert.ok(!ci.jobs.checks.steps.some((step) => step.run === 'pnpm test:e2e:catalog-admin-local'));
}

test('push and manual deployments require same-SHA unit, build and SDK checks', () => {
  const ci = workflow('ci');
  const release = workflow('deploy-test');
  assertReleaseGate(ci, release);
  assert.deepEqual(release.on.push.branches, ['test']);
  assert.ok(Object.hasOwn(release.on, 'workflow_dispatch'));
  assert.deepEqual(Object.keys(release.jobs).sort(), [
    'catalog-acceptance',
    'ci',
    'deploy',
    'prepare',
    'renderer-archive',
  ]);
});

test('the real archive policy shell handles the test environment flag after job selection, with recording disabled still succeeding', (t) => {
  const archive = workflow('deploy-test').jobs['renderer-archive'];
  assert.doesNotMatch(archive.if, /vars\./);
  const step = archive.steps.find((candidate) => candidate.id === 'catalog');
  const root = mkdtempSync(join(tmpdir(), 'catalog-archive-setting-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [flag, output] of [
    ['0', 'required=false\n'],
    ['1', 'required=true\n'],
  ]) {
    const file = join(root, `flag-${flag}`);
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      env: { PATH: process.env.PATH, CATALOG_SEO_RECORDING: flag, GITHUB_OUTPUT: file },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, 'utf8'), output);
  }
  const invalid = join(root, 'invalid');
  const result = spawnSync('bash', ['-e', '-c', step.run], {
    env: {
      PATH: process.env.PATH,
      CATALOG_SEO_RECORDING: 'never-log-this-value',
      GITHUB_OUTPUT: invalid,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(invalid), false);
  assert.equal(result.stderr.includes('never-log-this-value'), false);
  assert.deepEqual(workflow('deploy-test').jobs.deploy.needs, [
    'ci',
    'renderer-archive',
    'prepare',
  ]);
});

test('browser component units retain both required engines in the site unit group', () => {
  const ci = workflow('ci');
  const unit = ci.jobs.unit;
  const install = unit.steps.findIndex(
    (step) => step.run === 'pnpm exec playwright install --with-deps chromium webkit',
  );
  const tests = unit.steps.findIndex((step) => step.run === '${{ matrix.command }}');
  assert.ok(install >= 0 && install < tests);
  const mirror = unit.steps.findIndex(
    (step) => step.name === 'Use the Ubuntu archive for browser dependencies',
  );
  assert.ok(mirror >= 0 && mirror < install);
  assert.equal(unit.steps[mirror].if, "${{ matrix.suite == 'site' }}");
  assert.equal(unit.steps[install].if, "${{ matrix.suite == 'site' }}");
  assert.equal(unit.steps[tests].if, undefined);
  assert.equal(unit.steps[tests]['continue-on-error'], undefined);
  assert.ok(
    !ci.on.push.branches.includes('test'),
    'Deploy Test already invokes the same-SHA checks',
  );
});

test('full business regressions run separately for business changes and manual requests', () => {
  const regression = workflow('browser-regression');
  assert.ok(regression.on.pull_request.paths.includes('apps/site/**'));
  assert.ok(regression.on.pull_request.paths.includes('packages/**'));
  assert.ok(regression.on.pull_request.paths.includes('tests/**'));
  assert.ok(Object.hasOwn(regression.on, 'workflow_dispatch'));
  const job = regression.jobs.browser;
  assert.equal(
    job.environment,
    undefined,
    'local regressions do not enter the shared cloud environment',
  );
  assert.deepEqual(job.strategy.matrix.formal, ['0', '1']);
  assert.equal(job.env.E2E_CATALOG_FORMAL, '${{ matrix.formal }}');
  assert.ok(job.steps.some((step) => step.run === 'pnpm test:e2e:catalog-admin-local'));
  assert.ok(!JSON.stringify(job).includes('secrets.'));
});

test('deployed full browser suites are explicit requests rather than automatic release gates', () => {
  const release = workflow('deploy-test');
  assert.equal(release.on.workflow_dispatch.inputs.run_public_e2e.default, false);
  const step = release.jobs.deploy.steps.find(
    (step) => step.run === 'pnpm test:e2e:public && pnpm test:e2e:catalog',
  );
  assert.ok(step);
  assert.equal(step.if, "${{ github.event.inputs.run_public_e2e == 'true' }}");
  assert.equal(step['continue-on-error'], undefined);
  assert.ok(
    release.jobs.deploy.steps.some((step) => step.run === 'pnpm smoke:cloudbase' && !step.if),
  );
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
      candidate.jobs['renderer-archive'].needs = undefined;
    },
    (_ci, candidate) => {
      candidate.jobs['renderer-archive'].if = '${{ always() }}';
    },
    (_ci, candidate) => {
      candidate.jobs['renderer-archive'].steps.find((step) => step.id === 'catalog').if =
        "${{ vars.CATALOG_SEO_RECORDING == '1' }}";
    },
    (_ci, candidate) => {
      candidate.jobs['renderer-archive'].steps.find((step) =>
        step.run?.includes('archive-catalog-renderer.ts'),
      ).if = undefined;
    },
    (_ci, candidate) => {
      candidate.jobs.deploy.needs = undefined;
    },
    (_ci, candidate) => {
      candidate.jobs.deploy.needs = ['ci', 'renderer-archive'];
    },
    (_ci, candidate) => {
      candidate.jobs.prepare.steps.push({ run: 'pnpm deploy:cloudbase:test' });
    },
    (_ci, candidate) => {
      candidate.jobs.prepare.needs = undefined;
      candidate.jobs.deploy.if = candidate.jobs.deploy.if.replace(
        " && needs.prepare.result == 'success'",
        '',
      );
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
      candidate.jobs.checks.needs = undefined;
    },
    (candidate) => {
      candidate.jobs.unit['continue-on-error'] = true;
    },
    (candidate) => {
      candidate.jobs.unit.strategy.matrix.include.pop();
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

test('normal static publication reuses the frozen build and common recovery while preserving all backend delivery', () => {
  const release = workflow('deploy-test');
  const steps = release.jobs.deploy.steps;
  const position = (name) => steps.findIndex((step) => step.name === name);
  const exportBlog = position('Export accepted articles and verified images from formal CloudBase');
  const build = position('Build site');
  const seal = position('Record the complete same-run build and frozen public inputs');
  const functionBackup = position(
    'Capture all existing function packages before updating any function',
  );
  const preserve = position('Preserve function originals and configuration fingerprints');
  const backend = position('Deploy to CloudBase test');
  const delivery = position('Deliver the already verified full build through shared site recovery');
  const browser = position('Install the public acceptance browser before static writes');
  assert(
    exportBlog >= 0 &&
      exportBlog < build &&
      build < seal &&
      seal < functionBackup &&
      functionBackup < preserve &&
      preserve < backend &&
      backend < delivery,
  );
  assert(browser >= 0 && browser < backend);
  const expression = steps[build].env.SEO_BLOG_SNAPSHOT;
  const resolveSnapshot = (flag) =>
    Function(
      'vars',
      'github',
      'format',
      `return ${expression.slice(3, -2)}`,
    )({ BLOG_SERVER_ENABLED: flag }, { workspace: '/checked-source' }, (template, workspace) => {
      assert.equal(template, '{0}/output/seo-release/blog/snapshot.json');
      return `${workspace}/output/seo-release/blog/snapshot.json`;
    });
  assert.equal(resolveSnapshot(undefined), '/checked-source/output/seo-release/blog/snapshot.json');
  assert.equal(resolveSnapshot('0'), '/checked-source/output/seo-release/blog/snapshot.json');
  assert.equal(resolveSnapshot('1'), '');
  assert.equal(steps[exportBlog].if, "${{ vars.BLOG_SERVER_ENABLED != '1' }}");
  assert.equal(release.jobs.deploy.env.CHANNEL_COORDINATED_SITE_DELIVERY, '1');
  assert.equal(
    release.jobs.deploy.env.PUBLIC_BLOG_WORKSPACE,
    '0',
    'formal deployment must retain all existing admin sections',
  );
  for (const index of [seal, functionBackup, preserve, delivery]) {
    assert.equal(steps[index].if, undefined);
    assert.equal(steps[index]['continue-on-error'], undefined);
  }
  assert.equal(steps[delivery].env.SITE_DELIVERY_BUILT_INPUT, '1');
  assert.equal(steps[delivery].uses, 'actions/github-script@v7');
  assert.match(steps[delivery].with.script, /run-site-delivery.ts/);
  assert.equal(steps[delivery].env.JWT_SECRET, undefined);
  const complete = workflow('seo-module-1');
  assert.equal(
    `${release.jobs.ci.name} / ${complete.jobs.ready.name}`,
    'Verified source and browser checks / Required release checks',
  );
});

test('browser setup follows actual consumers without dropping mobile or component-engine coverage', () => {
  const ci = workflow('ci');
  assert(
    ci.jobs.checks.steps.some((s) => s.run === 'pnpm exec playwright install --with-deps chromium'),
  );
  assert(
    !ci.jobs.checks.steps.some(
      (s) => s.run === 'pnpm exec playwright install --with-deps chromium webkit',
    ),
  );
  const source = readFileSync(new URL('./verify-product-seo.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ chromium \} from '@playwright\/test'/);
  const blog = workflow('seo-module-1').jobs.blog;
  assert(blog.steps.some((s) => s.run === 'pnpm exec playwright install --with-deps chromium'));
  const regression = workflow('browser-regression');
  assert(
    regression.jobs.browser.steps.some(
      (s) => s.run === 'pnpm exec playwright install --with-deps chromium webkit',
    ),
  );
  assert(
    ci.jobs.unit.steps.some(
      (s) =>
        s.if === "${{ matrix.suite == 'site' }}" &&
        s.run === 'pnpm exec playwright install --with-deps chromium webkit',
    ),
  );
});

test('documentation-only pushes avoid live deployment while code, workflows and Markdown pages still deploy', () => {
  const ignored = workflow('deploy-test').on.push['paths-ignore'];
  assert.deepEqual(ignored, ['docs/**', 'AGENTS.md', 'README.md', 'CLOUD_HANDOFF.md']);
  const deploys = (files) =>
    files.some((file) => !ignored.some((pattern) => matchesGlob(file, pattern)));
  assert.equal(deploys(['docs/delivery/current.md', 'AGENTS.md']), false);
  for (const file of [
    'apps/site/src/pages/guide.md',
    'apps/site/astro.config.mjs',
    'apps/functions/admin/src/index.ts',
    'packages/articles/src/document.ts',
    'scripts/deploy-cloudbase-test.mjs',
    '.github/workflows/deploy-test.yml',
    'pnpm-lock.yaml',
    'package.json',
  ])
    assert.equal(deploys(['docs/note.md', file]), true, file);
  assert(workflow('deploy-test').on.workflow_dispatch);
});
