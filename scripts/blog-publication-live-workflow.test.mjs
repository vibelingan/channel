import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
test('real-site editor acceptance has no automatic trigger, keeps browser credentials separate and retains actual request IDs', () => {
  const flow = parse(readFileSync('.github/workflows/seo-blog-acceptance.yml', 'utf8'));
  assert.deepEqual(Object.keys(flow.on), ['workflow_call']);
  const job = flow.jobs.browser;
  assert.equal(job.environment, 'test');
  assert(!JSON.stringify(job.env).includes('secrets.'));
  const browser = job.steps.find((s) => s.run?.includes('blog-publication-live.spec.ts'));
  assert(browser.env.E2E_ADMIN_PASSWORD);
  assert(!JSON.stringify(browser.env).includes('TENCENTCLOUD'));
  const db = job.steps.find((s) => s.run?.includes('verify-publication-ui.ts'));
  assert(db.env.TENCENTCLOUD_SECRETKEY);
  assert(!JSON.stringify(db.env).includes('E2E_ADMIN_PASSWORD'));
  assert(
    job.steps.findIndex((s) => s.run?.includes('acceptance-preflight.mjs')) <
      job.steps.indexOf(browser),
  );
  const spec = readFileSync('tests/e2e/blog-publication-live.spec.ts', 'utf8');
  assert(!/routeFromHAR|route\.fulfill|host-resolver-rules|ignoreHTTPSErrors/.test(spec));
  assert.match(spec, /toHaveValue\(\s*\/\^oem-project-brief-acceptance-/);
});
test('local and wrong-target preflight fail before network even if a token exists', () => {
  for (const env of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' },
  ]) {
    const result = spawnSync(process.execPath, ['scripts/blog/acceptance-preflight.mjs'], {
      env: { PATH: process.env.PATH, GITHUB_TOKEN: 'fixture-never-transmitted', ...env },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Untrusted Blog API preparation/);
    assert(!result.stdout.includes('fixture-never-transmitted'));
  }
});
