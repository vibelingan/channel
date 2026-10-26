import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import {
  IMPORT_SETUP,
  assertImportRoute,
  assertImportSetupInput,
  pilotIntegration,
} from './blog/import-setup-policy.mjs';
const digest = 'f'.repeat(64);
const now = Date.parse('2026-10-26T05:00:00Z');
test('a pilot key is bounded, cannot be extended or silently reenabled, and revocation preserves unrelated fields', () => {
  const row = pilotIntegration(null, digest, 'initialize', now);
  assert.equal(Date.parse(row.expiresAt) - now, 2 * 60 * 60 * 1000);
  assert.deepEqual(pilotIntegration(row, digest, 'initialize', now + 1000), row);
  const revoked = pilotIntegration({ ...row, note: 'keep' }, digest, 'revoke', now + 1000);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.configRevision, 2);
  assert.equal(revoked.note, 'keep');
  for (const bad of [
    { ...row, secretDigest: '0'.repeat(64) },
    { ...row, integrationId: 'other' },
    revoked,
    { ...row, expiresAt: new Date(now + 3 * 60 * 60 * 1000).toISOString() },
  ])
    assert.throws(() => pilotIntegration(bad, digest, 'initialize', now));
  assert.throws(() => pilotIntegration(null, digest, 'revoke', now));
  assert.throws(() =>
    assertImportSetupInput({
      IMPORT_SETUP_OPERATION: 'initialize',
      IMPORT_SETUP_KEY_DIGEST: 'plaintext',
    }),
  );
});
test('only the exact standard-domain route with full paths and application bearer authorization is accepted', () => {
  const p = IMPORT_SETUP;
  const route = {
    Domain: p.domain,
    Path: p.path,
    UpstreamResourceType: 'SCF',
    UpstreamResourceName: p.functionName,
    Enable: true,
    EnableSafeDomain: false,
    EnableAuth: false,
    EnablePathTransmission: true,
  };
  assertImportRoute(route);
  for (const mutation of [
    { Domain: '*' },
    { Path: '/api' },
    { UpstreamResourceName: 'public-api' },
    { EnableAuth: true },
    { EnablePathTransmission: false },
    { Enable: false },
    { PathRewrite: { Prefix: '/other' } },
    { Extension: { HeadersHandler: {} } },
    { QPSPolicy: { QPSTotal: 1 } },
  ])
    assert.throws(() => assertImportRoute({ ...route, ...mutation }));
});
test('integration setup uses the shared manual queue, existing environment secrets and an Action archive identity', async () => {
  const parent = parse(await readFile('.github/workflows/seo-static-canary.yml', 'utf8'));
  const workflow = parse(await readFile('.github/workflows/seo-blog-import-setup.yml', 'utf8'));
  assert.equal(parent.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(parent.jobs.blog_import_setup.uses, './.github/workflows/seo-blog-import-setup.yml');
  assert(!workflow.on.push && !workflow.on.schedule && !workflow.on.workflow_dispatch);
  assert.equal(workflow.jobs.setup.environment, 'test');
  const action = workflow.jobs.setup.steps.find((s) => s.uses === 'actions/github-script@v7');
  assert(action.env.TENCENTCLOUD_SECRETID && action.env.TENCENTCLOUD_SECRETKEY);
  assert(!Object.hasOwn(workflow.jobs.setup.env, 'TENCENTCLOUD_SECRETKEY'));
  assert(action.with.script.includes('import-setup-live.ts'));
  const helperInstall = workflow.jobs.setup.steps.findIndex(
    (s) => s.run === 'npm ci --prefix tools/cloud-handoff --ignore-scripts --no-audit --no-fund',
  );
  assert(helperInstall >= 0 && helperInstall < workflow.jobs.setup.steps.indexOf(action));
});
