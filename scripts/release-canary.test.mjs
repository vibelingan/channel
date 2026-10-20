import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration } from './release-hosting-fixtures.mjs';
import { policy as basePolicy } from './release-state-fixtures.mjs';
import {
  canaryArtifact,
  createCanaryPayload,
  reviewCanaryPlan,
  verifyPlanToken,
} from './release/canary.mjs';
import { sha256 } from './release/input.mjs';
const policy = {
  ...basePolicy,
  workflowPath: '.github/workflows/seo-static-canary.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
  enabled: false,
};
const now = Date.parse('2026-10-21T00:00:00Z');
function payload(t, variant = 'A') {
  const directory = mkdtempSync(join(tmpdir(), 'canary-payload-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = createCanaryPayload({
    directory,
    policy,
    configuration: configuration(),
    variant,
    codeSha: 'a'.repeat(40),
    now,
  });
  const artifact = { id: '11', runId: '101', expiresAt: '2027-01-01T00:00:00Z', expired: false };
  const run = {
    repository: policy.repository,
    workflowPath: policy.workflowPath,
    event: 'workflow_dispatch',
    ref: policy.trustedRef,
    headSha: 'a'.repeat(40),
    runId: '101',
    artifact,
  };
  const input = canaryArtifact({ directory, policy, run, now });
  return { directory, manifest, input };
}
test('canary archive has exactly one inert noindex HTML file and no site/discovery/function payload', (t) => {
  const { manifest, input } = payload(t);
  assert.equal(input.envelope.scope.kind, 'canary');
  assert.deepEqual(
    input.staticManifest.entries.map((x) => x.path),
    ['__release-canary/index.html'],
  );
  assert.equal(manifest.snapshotPath, null);
  assert.deepEqual(manifest.functions, []);
  const html = readFileSync(join(input.directory, '__release-canary/index.html'), 'utf8');
  assert.match(html, /noindex,nofollow/);
  assert.doesNotMatch(html, /<script|<a\s|<form|https?:/i);
});
test('new release plan binds archive, current activation, executor SHA, reason and review expiry', (t) => {
  const { input } = payload(t);
  const request = {
    action: 'initialize',
    expectedActivationId: 'none',
    reason: 'canary review',
    executorSha: 'b'.repeat(40),
  };
  const status = { targetId: 't', scope: { version: 0, active: null }, state: 'uninitialized' };
  const plan = reviewCanaryPlan({ input, request, status, now });
  assert.equal(
    verifyPlanToken({ token: plan.token, input, request, status, now: now + 1000 }).sha256,
    plan.sha256,
  );
  for (const altered of [
    { ...request, action: 'publish' },
    { ...request, executorSha: 'c'.repeat(40) },
    { ...request, reason: 'changed' },
  ])
    assert.throws(() =>
      verifyPlanToken({ token: plan.token, input, request: altered, status, now }),
    );
  assert.throws(
    () => verifyPlanToken({ token: plan.token, input, request, status, now: now + 1_800_001 }),
    /expired/,
  );
  assert.throws(
    () =>
      verifyPlanToken({
        token: plan.token,
        input,
        request,
        status: { ...status, scope: { version: 1, active: { activationId: 'other' } } },
        now,
      }),
    /activation|plan/i,
  );
});
test('variant and target inputs are constrained before payload creation', (t) => {
  for (const variant of ['<script>', 'C', 'a']) assert.throws(() => payload(t, variant), /variant/);
  const { input } = payload(t);
  assert.equal(input.envelope.artifact.manifestSha256, sha256(JSON.stringify(input.payload)));
});
