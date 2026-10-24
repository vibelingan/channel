import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import {
  assertBlogBootstrapInvocation,
  BLOG_BOOTSTRAP_POLICY as policy,
} from './blog/bootstrap-policy.mjs';
const valid = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: policy.repository,
  GITHUB_REF: policy.trustedRef,
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '1',
  GITHUB_RUN_ATTEMPT: '1',
  TCB_ENV_ID: policy.envId,
  SITE_URL: policy.siteOrigin,
  CLOUDBASE_REGION: policy.region,
  BLOG_BOOTSTRAP_CONFIRM: 'BLOG_API_EXPANSION_ONLY',
};
test('Blog preparation targets only the approved environment and manual SEO executor', () => {
  assert.equal(assertBlogBootstrapInvocation(valid).functionName, 'admin');
  for (const field of Object.keys(valid)) {
    assert.throws(() => assertBlogBootstrapInvocation({ ...valid, [field]: 'other' }), field);
  }
});
test('bootstrap shares the existing queue without widening normal deployment triggers or inheriting unrelated secrets', () => {
  const root = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  const job = root.jobs.blog_bootstrap;
  assert.equal(job.uses, './.github/workflows/seo-blog-bootstrap.yml');
  assert.deepEqual(Object.keys(job.secrets).sort(), [
    'E2E_ADMIN_PASSWORD',
    'TENCENTCLOUD_SECRETID',
    'TENCENTCLOUD_SECRETKEY',
  ]);
  const child = parse(readFileSync('.github/workflows/seo-blog-bootstrap.yml', 'utf8'));
  assert.deepEqual(Object.keys(child.on), ['workflow_call']);
  assert.equal(child.jobs.prepare.environment, 'test');
  assert.equal(child.concurrency, undefined);
  assert.equal(root.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(root.concurrency['cancel-in-progress'], false);
  assert(!JSON.stringify(child).includes('JWT_SECRET'));
});
