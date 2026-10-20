import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const read = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

function assertOffline(workflow) {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['offline']);
  assert.deepEqual(Object.keys(workflow.jobs.offline).sort(), [
    'name',
    'runs-on',
    'steps',
    'timeout-minutes',
  ]);
  assert.deepEqual(workflow.on.push.branches, ['feat/seo-foundation']);
  assert.equal(Object.hasOwn(workflow.on, 'workflow_run'), false);
  assert.equal(Object.hasOwn(workflow.on, 'pull_request_target'), false);
  assert.notEqual(workflow.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(workflow.env, undefined);
  for (const step of workflow.jobs.offline.steps) {
    assert.equal(step.env, undefined);
    assert.equal(step.secrets, undefined);
    assert.doesNotMatch(
      JSON.stringify(step),
      /secrets\.|id-token|TCB_|CLOUDBASE_|deploy:|workflow run|cloudbase-deploy-test/,
    );
    if (step.uses)
      assert.ok(
        [
          'actions/checkout@v4',
          'pnpm/action-setup@v4',
          'actions/setup-node@v4',
          'actions/upload-artifact@v4',
        ].includes(step.uses),
      );
  }
  const checkout = workflow.jobs.offline.steps.find((s) => s.uses === 'actions/checkout@v4');
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const commands = workflow.jobs.offline.steps.filter((s) => s.run).map((s) => s.run);
  assert.equal(commands.length, 4);
  assert.equal(commands[0], 'pnpm install --frozen-lockfile --ignore-scripts');
  assert.equal(commands[1], 'pnpm lint');
  assert.equal(commands[2], 'pnpm verify:cloudbase-sdk');
  assert.equal(
    commands[3],
    'set -o pipefail\nmkdir -p output/seo-module-1\npnpm test 2>&1 | tee output/seo-module-1/tests.log\n',
  );
}

test('module CI has only read permissions, offline tests and GitHub test artifacts', () =>
  assertOffline(read('seo-module-1')));

test('the CI guard detects credentials, deployments and a widened trigger', () => {
  for (const mutate of [
    (w) => {
      w.permissions['id-token'] = 'write';
    },
    (w) => {
      w.jobs.offline.environment = 'test';
    },
    (w) => {
      w.jobs.deploy = { uses: './.github/workflows/deploy-test.yml' };
    },
    (w) => {
      w.jobs.offline.steps.push({ run: 'pnpm deploy:cloudbase:test' });
    },
    (w) => {
      w.on.push.branches.push('test');
    },
    (w) => {
      w.jobs.offline.steps[0].with.token = '${{ secrets.CLOUD_TOKEN }}';
    },
  ]) {
    const workflow = read('seo-module-1');
    mutate(workflow);
    assert.throws(() => assertOffline(workflow));
  }
});

test('feature branch push is outside every existing automatic deployment trigger', () => {
  const release = read('deploy-test');
  assert.deepEqual(release.on.push.branches, ['test']);
  const ai = read('deploy-ai-cloudrun');
  assert.deepEqual(ai.on.push, { tags: ['ai-cloudrun-deploy-*'] });
});
