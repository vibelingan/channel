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
