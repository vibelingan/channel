import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { formalRegistration, FORMAL_BLOG as p } from './formal-policy.mjs';
test('formal initialization is fixed to one owned integration and creates a separate due maintenance policy', () => {
  const input = { keyId: p.keyId, integrationId: p.integrationId, keyDigest: 'f'.repeat(64) };
  const now = Date.now();
  const value = formalRegistration(input, now);
  assert.equal(Date.parse(value.key.expiresAt) - now, 90 * 86400000);
  assert.equal(Date.parse(value.policy.rotateAfter), now);
  assert.equal(value.key.configRevision, 1);
  assert.equal(value.policy._id, `managed-${p.keyId}`);
  for (const changed of [
    { ...input, keyId: 'another-app' },
    { ...input, integrationId: 'another-site' },
    { ...input, enabled: true },
    { ...input, keyDigest: '' },
  ])
    assert.throws(() => formalRegistration(changed, now));
});
test('formal deployment keeps repository-root artifact paths and uses only one fixed function', () => {
  const flow = parse(
    readFileSync(new URL('../../.github/workflows/seo-blog-formal.yml', import.meta.url), 'utf8'),
  );
  const job = flow.jobs.prepare;
  const step = job.steps.find((item) => item.env?.TENCENTCLOUD_SECRETKEY);
  assert.equal(step.uses, 'actions/github-script@v7');
  assert(
    step.with.script.includes(
      "spawn('./packages/db/node_modules/.bin/tsx',['scripts/blog/formal-live.ts']",
    ),
  );
  assert(step.with.script.includes('env:process.env'));
  assert.equal(step['working-directory'], undefined);
  assert.equal(job.env.TENCENTCLOUD_SECRETKEY, undefined);
  assert.equal(job.environment, 'test');
  const source = readFileSync(new URL('./formal-live.ts', import.meta.url), 'utf8');
  assert.match(source, /names: \[p.functionName\]/);
  assert.match(source, /uploadArtifact/);
  assert(source.indexOf('uploadArtifact') < source.indexOf('provider.updateCode'));
  assert(!/createFunction|deleteFunction|manageGateway|manageHosting/.test(source));
});
