import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
const workflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
test('SEO integration runs the same-SHA reusable CI and full business browsers without deployment secrets', () => {
  const seo = workflow('seo-module-1');
  assert.ok(seo.on.push.branches.includes('feat/seo-foundation'));
  assert.equal(seo.jobs.ci.uses, './.github/workflows/ci.yml');
  assert.equal(seo.jobs.catalog.uses, './.github/workflows/browser-regression.yml');
  assert.ok(Object.hasOwn(workflow('browser-regression').on, 'workflow_call'));
  for (const job of [seo.jobs.ci, seo.jobs.catalog]) {
    assert.equal(job.if, undefined);
    assert.equal(job.secrets, undefined);
    assert.equal(job['continue-on-error'], undefined);
  }
  const suites = workflow('ci').jobs.unit.strategy.matrix.include.map((item) => item.suite);
  assert.deepEqual(suites, ['scripts', 'packages', 'services', 'site']);
  assert.ok(!JSON.stringify(seo.jobs).includes('secrets.'));
});
test('Blog regression exercises real local editor and published HTML without cloud writes', () => {
  const job = workflow('seo-module-1').jobs.blog;
  assert.equal(job.environment, undefined);
  assert.equal(job.if, undefined);
  const commands = job.steps.map((step) => step.run ?? '').join('\n');
  assert.match(commands, /run-catalog-admin-local-e2e.mjs --articles-only/);
  assert.match(commands, /run-blog-public-local-e2e.mjs/);
  assert.doesNotMatch(commands, /--build-only|workflow run|deploy:cloudbase|continue-on-error/);
  assert.ok(job.steps.every((step) => step['continue-on-error'] === undefined));
});
