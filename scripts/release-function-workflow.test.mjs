import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { runFunctionRecovery, validateFunctionInvocation } from './run-function-recovery.mjs';
const policy = JSON.parse(
  readFileSync(new URL('./release/function-recovery-policy.json', import.meta.url)),
);
const workflow = parse(
  readFileSync(new URL('../.github/workflows/seo-static-canary.yml', import.meta.url), 'utf8'),
);
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: policy.repository,
  GITHUB_REF: policy.trustedRef,
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '11',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_JOB: 'functions',
  FUNCTION_MODE: 'observe',
};
test('all manual modes select exactly one job and retain the existing shared target lock', () => {
  const run = (expression, mode, action = 'initialize') =>
    Function(
      'github',
      'inputs',
      'startsWith',
      `return ${expression.slice(3, -2)}`,
    )({ ref: policy.trustedRef }, { mode, action }, (x, p) => x.startsWith(p));
  for (const mode of workflow.on.workflow_dispatch.inputs.mode.options) {
    const selected = Object.entries(workflow.jobs)
      .filter(([, job]) => run(job.if, mode))
      .map(([key]) => key);
    assert.deepEqual(selected, [
      mode === 'catalog-prepare'
        ? 'catalog_prepare'
        : mode.startsWith('catalog-clock-')
          ? 'catalog_clock'
          : mode === 'renderer-archive'
            ? 'renderer_archive'
            : mode === 'catalog-probe'
              ? 'catalog_probe'
              : mode === 'blog-images-prepare'
                ? 'blog_images_prepare'
                : mode === 'blog-formal-prepare'
                  ? 'blog_formal_prepare'
                  : mode === 'cloud-readiness'
                    ? 'cloud_readiness'
                    : mode === 'blog-import-setup'
                      ? 'blog_import_setup'
                      : mode === 'site-readback'
                        ? 'site_readback'
                        : mode === 'blog-server-update'
                          ? 'blog_server_update'
                          : mode.startsWith('function-')
                            ? 'functions'
                            : ['dummy-recovery', 'dummy-readback', 'dummy-cleanup'].includes(mode)
                              ? 'dummy_recovery'
                              : mode === 'maintenance'
                                ? 'maintenance'
                                : mode === 'blog-server-route'
                                  ? 'blog_server_route'
                                  : mode === 'blog-server-switch'
                                    ? 'blog_server_switch'
                                    : mode === 'blog-server-apis'
                                      ? 'blog_server_apis'
                                      : mode === 'blog-server-stage'
                                        ? 'blog_server_stage'
                                        : mode === 'blog-bootstrap'
                                          ? 'blog_bootstrap'
                                          : ['site-delivery', 'catalog-bootstrap'].includes(mode)
                                            ? 'site_delivery'
                                            : mode === 'blog-enable'
                                              ? 'blog_enable'
                                              : [
                                                    'blog-create',
                                                    'blog-retry',
                                                    'blog-update',
                                                    'blog-withdraw',
                                                    'blog-check',
                                                    'blog-import-review',
                                                    'blog-import-publish',
                                                    'blog-import-withdraw',
                                                  ].includes(mode)
                                                ? 'blog_acceptance'
                                                : 'canary',
    ]);
  }
  assert.equal(run(workflow.jobs.blog_images_prepare.if, 'blog-images-prepare', 'restore'), false);
  assert.equal(run(workflow.jobs.blog_images_prepare.if, 'blog-images-prepare', 'publish'), false);
  assert.equal(run(workflow.jobs.blog_formal_prepare.if, 'blog-formal-prepare', 'restore'), false);
  assert.equal(run(workflow.jobs.blog_formal_prepare.if, 'blog-formal-prepare', 'publish'), false);
  assert.deepEqual(workflow.concurrency, {
    group: 'cloudbase-deploy-test',
    'cancel-in-progress': false,
    queue: 'max',
  });
  assert.equal(workflow.jobs.functions.environment, 'test');
  assert.equal(Object.keys(workflow.on.workflow_dispatch.inputs).length, 12);
});
test('function workflow runs credentials only in the two function commands and archives before executing', () => {
  const job = workflow.jobs.functions;
  assert.equal(job.env.TENCENTCLOUD_SECRETKEY, undefined);
  const cloud = job.steps.filter((s) => s.env?.TENCENTCLOUD_SECRETKEY);
  assert.equal(cloud.length, 2);
  assert(cloud.every((s) => /^node scripts\/run-function-recovery.mjs /.test(s.run)));
  const upload = job.steps.findIndex((s) => s.id === 'payload');
  const execute = job.steps.findIndex(
    (s) => s.run === 'node scripts/run-function-recovery.mjs run',
  );
  assert(execute > upload);
  assert.match(job.steps[execute].if, /function-observe/);
  assert.match(job.steps[execute].if, /function-certify/);
  assert(!JSON.stringify(job.steps.map((s) => s.run)).includes('${{ inputs.'));
  assert(!job.steps.some((s) => /deploy-cloudbase|pnpm build/.test(s.run ?? '')));
  assert.deepEqual(
    workflow.on.workflow_dispatch.inputs.variant.options.filter((x) => !['A', 'B'].includes(x)),
    policy.functions,
  );
  assert(policy.observeFunctions.includes('alibaba-catalog-sync'));
  assert.equal(policy.enabled, false);
  assert.equal(policy.writerInventorySha256, null);
  assert.equal(policy.clientInventorySha256, null);
  assert.deepEqual(policy.compatibilitySuites, []);
});
test('invalid/local/automatic invocations and disabled execute stop before SDK or network', async () => {
  assert.equal(validateFunctionInvocation(env, policy).owner.ownerRunId, 'github-11-1');
  for (const change of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_JOB: 'canary' },
    { GITHUB_RUN_ATTEMPT: '' },
    { FUNCTION_MODE: 'publish' },
  ])
    assert.throws(() => validateFunctionInvocation({ ...env, ...change }, policy));
  await assert.rejects(
    runFunctionRecovery('prepare', {
      ...env,
      FUNCTION_MODE: 'execute',
      FUNCTION_PLAN_TOKEN: 'fake',
    }),
    /disabled/,
  );
});

test('manual entry database construction resolves the installed SDK from its direct pnpm workspace owner', async () => {
  const { createCloudbaseReleaseDatabase, createCloudbaseReleaseStore } = await import(
    './release/store-cloudbase.mjs'
  );
  const db = createCloudbaseReleaseDatabase({
    envId: 'fixture-env',
    env: 'fixture-env',
    region: 'ap-shanghai',
    secretId: 'fixture-id',
    secretKey: 'fixture-key',
  });
  assert.equal(db.config.env, 'fixture-env');
  assert.equal(typeof db.runTransaction, 'function');
  assert.equal(createCloudbaseReleaseStore({ db, envId: 'fixture-env' }).envId, 'fixture-env');
});
test('failure diagnostics retain a safe stage and code without raw messages or undefined identifiers', async () => {
  const { safeFunctionFailure } = await import('./run-function-recovery.mjs');
  assert.equal(safeFunctionFailure(new Error('private fixture value')).stage, 'preflight-or-plan');
  assert.equal(
    safeFunctionFailure({ stage: 'observe', code: 'MODULE_NOT_FOUND' }).code,
    'MODULE_NOT_FOUND',
  );
  assert(
    !JSON.stringify(
      safeFunctionFailure({ stage: undefined, message: 'private fixture value' }),
    ).includes('private fixture value'),
  );
});

test('historical renderer checkout leaves the reviewed executor in place', () => {
  const steps = workflow.jobs.renderer_archive.steps;
  const selected = steps.find((step) => step.with?.path === 'renderer-source');
  assert.ok(selected);
  assert.equal(selected.uses, 'actions/checkout@v4');
  assert.equal(selected.with.ref, '${{ inputs.renderer_sha }}');
  assert.equal(selected.with['persist-credentials'], false);
});
