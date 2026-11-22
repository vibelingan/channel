import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { parse } from 'yaml';

test('image repair has only the manual original-branch entry and inherits the shared target lock', () => {
  const caller = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  assert.equal(caller.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(caller.concurrency['cancel-in-progress'], false);
  const job = caller.jobs.image_delivery_prepare;
  const selected = (ref, mode, action) =>
    Function('github', 'inputs', `return ${job.if.slice(3, -2)}`)({ ref }, { mode, action });
  assert.equal(
    selected('refs/heads/feat/seo-foundation', 'image-delivery-prepare', 'initialize'),
    true,
  );
  for (const [ref, mode, action] of [
    ['refs/heads/main', 'image-delivery-prepare', 'initialize'],
    ['refs/heads/feat/seo-foundation', 'plan', 'initialize'],
    ['refs/heads/feat/seo-foundation', 'image-delivery-prepare', 'invalid'],
  ])
    assert.equal(selected(ref, mode, action), false);
  const workflow = parse(readFileSync('.github/workflows/seo-image-delivery.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.equal(workflow.jobs.prepare.environment, 'test');
  assert.equal(
    selected('refs/heads/feat/seo-foundation', 'image-delivery-prepare', 'restore'),
    true,
  );
  assert.equal(workflow.jobs.restore.environment, 'test');
  assert.equal(
    workflow.jobs.restore.steps.find((s) => s.uses === 'actions/download-artifact@v4').with[
      'run-id'
    ],
    43748962618,
  );
});
test('selected-size preparation shares the deploy queue and cannot run from another branch or restore action', () => {
  const caller = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  const deploy = parse(readFileSync('.github/workflows/deploy-test.yml', 'utf8'));
  assert.deepEqual(caller.concurrency, deploy.concurrency);
  const job = caller.jobs.image_sizes_prepare;
  const selected = (ref, mode, action) =>
    Function('github', 'inputs', `return ${job.if.slice(3, -2)}`)({ ref }, { mode, action });
  assert.equal(
    selected('refs/heads/feat/seo-foundation', 'image-sizes-prepare', 'initialize'),
    true,
  );
  for (const args of [
    ['refs/heads/main', 'image-sizes-prepare', 'initialize'],
    ['refs/heads/feat/seo-foundation', 'image-sizes-prepare', 'restore'],
    ['refs/heads/feat/seo-foundation', 'plan', 'initialize'],
  ])
    assert.equal(selected(...args), false);
  const workflow = parse(readFileSync('.github/workflows/seo-image-delivery.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.equal(workflow.jobs.responsive.environment, 'test');
  assert.equal(job.with.operation, 'responsive');
  assert.equal(job.with.responsive_batch, '${{ inputs.image_batch }}');
  assert.equal(
    workflow.jobs.responsive.env.IMAGE_RESPONSIVE_BATCH,
    '${{ inputs.responsive_batch }}',
  );
  assert.equal(workflow.jobs.responsive.env.TENCENTCLOUD_SECRETKEY, undefined);
  assert.equal(
    workflow.jobs.responsive.steps.filter((step) => step.env?.TENCENTCLOUD_SECRETKEY).length,
    1,
  );
  assert.ok(
    !workflow.jobs.responsive.steps.some((step) =>
      /deploy-cloudbase|repair-live|restore-public-api|package:functions/.test(step.run ?? ''),
    ),
  );
});
test('the explicit publish action ships fresh HTML after image preparation succeeds', () => {
  const caller = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  const image = caller.jobs.image_sizes_prepare;
  const site = caller.jobs.image_sizes_publish;
  assert.ok(site, 'The published sizes need a website delivery job');
  assert.equal(site.needs, 'image_sizes_prepare');
  const branch = 'refs/heads/feat/seo-foundation';
  const active = (job, ref, mode, action, result) =>
    Function(
      'github',
      'inputs',
      'needs',
      `return ${job.if.slice(3, -2)}`,
    )({ ref }, { mode, action }, { image_sizes_prepare: { result } });
  assert.equal(active(image, branch, 'image-sizes-prepare', 'publish'), true);
  assert.equal(active(site, branch, 'image-sizes-prepare', 'publish', 'success'), true);
  for (const [ref, mode, action, result] of [
    ['refs/heads/main', 'image-sizes-prepare', 'publish', 'success'],
    [branch, 'image-delivery-prepare', 'publish', 'success'],
    [branch, 'image-sizes-prepare', 'initialize', 'success'],
    [branch, 'image-sizes-prepare', 'publish', 'failure'],
    [branch, 'image-sizes-prepare', 'publish', 'cancelled'],
    [branch, 'image-sizes-prepare', 'publish', 'skipped'],
  ]) {
    assert.equal(active(site, ref, mode, action, result), false);
  }
  assert.equal(site.uses, './.github/workflows/seo-site-delivery.yml');
  assert.deepEqual(site.with, {
    action: 'publish',
    product_source: 'fresh',
    renderer_sha: '${{ inputs.renderer_sha }}',
  });
  assert.equal(image.with.publish_responsive_html, "${{ inputs.action == 'publish' }}");
  assert.equal(image.with.responsive_renderer_sha, '${{ inputs.renderer_sha }}');
});

test('combined image publication requires an exact renderer before writing any sizes', () => {
  const workflow = parse(readFileSync('.github/workflows/seo-image-delivery.yml', 'utf8'));
  const steps = workflow.jobs.responsive.steps;
  const gate = steps.find(
    (step) => step.name === 'Require a pinned renderer for website publication',
  );
  assert.ok(gate, 'Combined publication needs a renderer input gate');
  assert.ok(steps.indexOf(gate) < steps.findIndex((step) => step.env?.TENCENTCLOUD_SECRETKEY));
  assert.equal(gate.if, '${{ inputs.publish_responsive_html }}');
  for (const sha of ['', 'main', 'a'.repeat(39), 'a'.repeat(40)]) {
    const result = spawnSync('bash', ['-ec', gate.run], {
      env: { PATH: process.env.PATH, APPROVED_RENDERER_SHA: sha },
      timeout: 5000,
      encoding: 'utf8',
    });
    assert.equal(result.status, sha.length === 40 ? 0 : 1, result.stderr);
  }
});

test('the API-only entry requires the original branch, exact function and explicit action', () => {
  const caller = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  const job = caller.jobs.image_api_update;
  const selected = (ref, mode, action, variant) =>
    Function(
      'github',
      'inputs',
      `return ${job.if.slice(3, -2)}`,
    )({ ref }, { mode, action, variant });
  assert.equal(
    selected('refs/heads/feat/seo-foundation', 'image-api-update', 'initialize', 'public-api'),
    true,
  );
  for (const args of [
    ['refs/heads/main', 'image-api-update', 'initialize', 'public-api'],
    ['refs/heads/feat/seo-foundation', 'image-api-update', 'restore', 'public-api'],
    ['refs/heads/feat/seo-foundation', 'image-api-update', 'initialize', 'admin'],
    ['refs/heads/feat/seo-foundation', 'image-delivery-prepare', 'initialize', 'public-api'],
  ])
    assert.equal(selected(...args), false);
  assert.equal(job.with.operation, 'api-only');
  assert.equal(caller.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(caller.concurrency['cancel-in-progress'], false);
  const workflow = parse(readFileSync('.github/workflows/seo-image-delivery.yml', 'utf8'));
  const eligible = (ref, event_name, operation) =>
    Function(
      'github',
      'inputs',
      `return ${workflow.jobs.prepare.if.slice(3, -2)}`,
    )({ ref, event_name }, { operation });
  assert.equal(eligible('refs/heads/feat/seo-foundation', 'workflow_dispatch', 'api-only'), true);
  assert.equal(eligible('refs/heads/feat/seo-foundation', 'push', 'api-only'), false);
  assert.equal(eligible('refs/heads/feat/seo-foundation', 'workflow_dispatch', 'invalid'), false);
  const confirm = (operation) =>
    Function(
      'inputs',
      `return ${workflow.jobs.prepare.env.IMAGE_DELIVERY_CONFIRM.slice(3, -2)}`,
    )({ operation });
  assert.equal(confirm('api-only'), 'UPDATE_PUBLIC_API_ONLY');
  assert.equal(confirm('prepare'), 'PREPARE_WEB_IMAGES_AND_PUBLIC_API_ONLY');
});
test('recovery refuses local invocation before reading artifacts or contacting CloudBase', () => {
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['--import', require.resolve('tsx/esm'), 'scripts/images/restore-public-api.ts'],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 20000, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Untrusted public API recovery invocation/);
});
test('the actual repair program rejects a local or unauthenticated invocation before cloud operations', () => {
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const loader = require.resolve('tsx/esm');
  const result = spawnSync(
    process.execPath,
    ['--import', loader, 'scripts/images/repair-live.ts'],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 20000, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Untrusted image repair invocation/);
});
