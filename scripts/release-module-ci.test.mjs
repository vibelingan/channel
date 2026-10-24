import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const read = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

function assertOffline(workflow) {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['ci', 'catalog', 'blog']);
  assert.deepEqual(workflow.on.push.branches, ['feat/seo-foundation']);
  assert.equal(Object.hasOwn(workflow.on, 'workflow_run'), false);
  assert.equal(Object.hasOwn(workflow.on, 'pull_request_target'), false);
  assert.notEqual(workflow.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(workflow.env, undefined);
  for (const [job, source] of [
    ['ci', 'ci'],
    ['catalog', 'browser-regression'],
  ]) {
    assert.equal(workflow.jobs[job].uses, `./.github/workflows/${source}.yml`);
    assert.ok(Object.hasOwn(read(source).on, 'workflow_call'));
    assert.deepEqual(Object.keys(workflow.jobs[job]).sort(), ['name', 'uses']);
    for (const child of Object.values(read(source).jobs)) {
      assert.equal(child.environment, undefined);
      assert.equal(child.secrets, undefined);
      assert.doesNotMatch(JSON.stringify(child), /\$\{\{\s*secrets\.|pnpm deploy:|workflow run/);
    }
  }
  const blog = workflow.jobs.blog;
  assert.deepEqual(Object.keys(blog).sort(), ['name', 'runs-on', 'steps', 'timeout-minutes']);
  for (const step of blog.steps) {
    assert.equal(step.env, undefined);
    assert.equal(step.secrets, undefined);
    assert.equal(step['continue-on-error'], undefined);
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
  const checkout = blog.steps.find((step) => step.uses === 'actions/checkout@v4');
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const commands = blog.steps.filter((step) => step.run).map((step) => step.run);
  assert.deepEqual(commands, [
    'pnpm install --frozen-lockfile',
    'pnpm exec playwright install --with-deps chromium webkit',
    'node scripts/run-catalog-admin-local-e2e.mjs --articles-only',
    'node scripts/run-blog-public-local-e2e.mjs',
  ]);
}

test('module CI has only read permissions, offline tests and GitHub test artifacts', () =>
  assertOffline(read('seo-module-1')));

test('the CI guard detects credentials, deployments and a widened trigger', () => {
  for (const mutate of [
    (w) => {
      w.jobs.ci.uses += '@main';
    },
    (w) => {
      w.permissions['id-token'] = 'write';
    },
    (w) => {
      w.jobs.blog.environment = 'test';
    },
    (w) => {
      w.jobs.deploy = { uses: './.github/workflows/deploy-test.yml' };
    },
    (w) => {
      w.jobs.blog.steps.push({ run: 'pnpm deploy:cloudbase:test' });
    },
    (w) => {
      w.on.push.branches.push('test');
    },
    (w) => {
      w.jobs.blog.steps[0].with.token = '${{ secrets.CLOUD_TOKEN }}';
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
