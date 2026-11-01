import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import {
  assertSiteReconcileInvocation,
  assertStoppedCatalogReceipt,
  assertStoppedFunctionsAbsent,
} from './run-site-reconcile.mjs';
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: policy.repository,
  GITHUB_REF: policy.trustedRef,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `${policy.repository}/${policy.workflowPath}@${policy.trustedRef}`,
  TCB_ENV_ID: policy.envId,
  SITE_URL: policy.siteOrigin,
  CLOUDBASE_REGION: policy.region,
  SITE_RECONCILE_CONFIRM: 'STOPPED_HTML_ONLY',
  SITE_RECONCILE_RUN_ID: 'site-41313740695-1',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '41313799999',
  GITHUB_RUN_ATTEMPT: '1',
  TENCENTCLOUD_SECRETID: 'test-only',
  TENCENTCLOUD_SECRETKEY: 'test-only',
  GITHUB_TOKEN: 'test-only',
};
const context = {
  runId: 'site-41313740695-1',
  codeSha: 'b'.repeat(40),
  githubRunId: '41313740695',
  attempt: '1',
};
const receipt = {
  schemaVersion: 1,
  purpose: 'catalog-seo-regional-v1',
  runId: context.runId,
  codeSha: context.codeSha,
  functionName: 'seo-catalog-region-41313740695-1',
  environment: policy.envId,
  created: true,
  cleaned: true,
  unconfirmed: false,
  websiteWrites: 0,
  businessWrites: 0,
  calls: [
    { action: 'health', state: 'completed', requestId: 'fixed-health' },
    { action: 'delivery.end', state: 'completed', requestId: 'fixed-delivery' },
  ],
};

test('only the pinned manual operation can enter stopped-site reconciliation', () => {
  assert.equal(assertSiteReconcileInvocation(env), policy);
  for (const [key, value] of Object.entries({
    GITHUB_REF: 'refs/heads/test',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_WORKFLOW_REF: 'untrusted',
    TCB_ENV_ID: 'other',
    SITE_URL: 'https://other.example',
    CLOUDBASE_REGION: 'eu-frankfurt',
    SITE_RECONCILE_CONFIRM: '',
    SITE_RECONCILE_RUN_ID: 'site-41313799999-1',
    GITHUB_SHA: 'invalid',
    GITHUB_RUN_ID: '',
    TENCENTCLOUD_SECRETID: '',
    TENCENTCLOUD_SECRETKEY: '',
    GITHUB_TOKEN: '',
  }))
    assert.throws(() => assertSiteReconcileInvocation({ ...env, [key]: value }), key);
});

test('a closed, exact old worker receipt is required, not just a successful invocation', () => {
  assert.doesNotThrow(() => assertStoppedCatalogReceipt(receipt, context));
  for (const patch of [
    { cleaned: false },
    { unconfirmed: true },
    { runId: 'other' },
    { codeSha: 'c'.repeat(40) },
    { environment: 'other' },
    { businessWrites: 1 },
    { calls: [{ action: 'delivery.accept', state: 'completed', requestId: 'wrong' }] },
    { calls: [...receipt.calls, { action: 'seed', state: 'unconfirmed', requestId: 'unknown' }] },
  ])
    assert.throws(() => assertStoppedCatalogReceipt({ ...receipt, ...patch }, context));
});

test('a previous technical recovery is allowed in a later stopped writer receipt', () => {
  const recovered = {
    ...receipt,
    calls: [
      ...receipt.calls,
      { action: 'recovery.clear', state: 'readback-confirmed', requestId: 'prior-recovery' },
    ],
  };
  assert.doesNotThrow(() => assertStoppedCatalogReceipt(recovered, context));
  for (const state of ['unconfirmed', 'failed', 'running'])
    assert.throws(() =>
      assertStoppedCatalogReceipt(
        {
          ...recovered,
          calls: [
            ...receipt.calls,
            { action: 'recovery.clear', state, requestId: 'not-confirmed' },
          ],
        },
        context,
      ),
    );
});

test('function absence checks every page and never deletes an unrelated function', async () => {
  const calls = [];
  const functions = {
    listFunctions: async (limit, offset) => {
      calls.push([limit, offset]);
      return offset === 0
        ? Array.from({ length: 100 }, (_, i) => ({ FunctionName: `unrelated-${i}` }))
        : [{ FunctionName: 'old-worker' }];
    },
  };
  await assert.rejects(assertStoppedFunctionsAbsent(functions, ['old-worker']), /still exists/);
  assert.deepEqual(calls, [
    [100, 0],
    [100, 100],
  ]);
  await assert.doesNotReject(assertStoppedFunctionsAbsent(functions, ['absent-worker']));
  await assert.rejects(
    assertStoppedFunctionsAbsent({ listFunctions: async () => ({}) }, ['worker']),
  );
});

test('manual reconciliation shares the deploy queue, has no website upload and always retains its receipt', () => {
  const parent = parse(
    readFileSync(new URL('../.github/workflows/seo-static-canary.yml', import.meta.url), 'utf8'),
  );
  const child = parse(
    readFileSync(new URL('../.github/workflows/seo-site-reconcile.yml', import.meta.url), 'utf8'),
  );
  assert.equal(parent.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(parent.concurrency['cancel-in-progress'], false);
  assert.match(parent.jobs.site_reconcile.if, /feat\/seo-foundation/);
  assert.equal(parent.jobs.site_reconcile.with.source_run_id, '${{ inputs.restore_run_id }}');
  assert.equal(child.jobs.reconcile.environment, 'test');
  assert.equal(child.jobs.reconcile.env.SITE_RECONCILE_CONFIRM, 'STOPPED_HTML_ONLY');
  const steps = child.jobs.reconcile.steps;
  assert.ok(steps.some((step) => step.run === 'node scripts/run-site-reconcile.mjs'));
  const archive = steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  assert.equal(archive.if, 'always()');
  assert.match(archive.with.path, /release-regional\/result\.json/);
  const source = readFileSync(new URL('./run-site-reconcile.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /(?:uploadFile|deleteFile|updateFunction|updateWebsite|deployHosting)\(/,
  );
});

test('both formal and controlled delivery retain supplemental cleanup and catalog recovery evidence', () => {
  for (const path of ['deploy-test.yml', 'seo-site-delivery.yml']) {
    const workflow = parse(
      readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), 'utf8'),
    );
    const archives = Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).filter(
        (step) =>
          step.uses === 'actions/upload-artifact@v4' &&
          step.with?.name?.startsWith('site-delivery-evidence-'),
      ),
    );
    assert.equal(archives.length, 1, path);
    assert.equal(archives[0].if, 'always()');
    for (const name of [
      'preparation-check.json',
      'preparation-cleanup.json',
      'stopped-catalog-recovery.json',
    ])
      assert.ok(archives[0].with.path.split('\n').includes(`output/site-delivery/${name}`), path);
  }
});
