import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publicFiles } from './release-fixtures.mjs';
import { configuration, errorHtml } from './release-hosting-fixtures.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
const policy = {
  repository: 'fixture/channel',
  workflowPath: '.github/workflows/deploy-test.yml',
  trustedRef: 'refs/heads/test',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'site-payload-'));
  rmSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    policy,
    configuration: configuration(),
    codeSha: 'a'.repeat(40),
    releaseId: 'site-A',
    snapshot: {
      schemaVersion: 1,
      purpose: 'legacy-public-inventory',
      siteOrigin: policy.siteOrigin,
    },
    files: new Map(
      Object.entries({ ...publicFiles(), 'errors/not-found.html': errorHtml }).map(([p, b]) => [
        p,
        Buffer.from(b),
      ]),
    ),
  };
}
function run() {
  return {
    repository: policy.repository,
    workflowPath: policy.workflowPath,
    event: 'workflow_dispatch',
    ref: policy.trustedRef,
    headSha: 'a'.repeat(40),
    runId: '1',
    artifact: { id: '10', runId: '1', expired: false, expiresAt: '2026-12-31T00:00:00Z' },
  };
}
test('full site payload keeps snapshot and ownership verifiable before any upload', (t) => {
  const f = fixture(t);
  createSitePayload(f);
  const input = siteArtifact({ ...f, run: run() });
  assert.equal(input.envelope.scope.kind, 'site');
  assert.equal(input.staticManifest.entries.length, f.files.size);
  assert.equal(
    readFileSync(join(f.directory, 'index.html'), 'utf8'),
    f.files.get('index.html').toString(),
  );
  writeFileSync(join(f.directory, 'index.html'), 'changed');
  assert.throws(() => siteArtifact({ ...f, run: run() }), /Corrupt/);
});
for (const path of [
  '__auth/x.html',
  'BingSiteAuth.xml',
  '404.html',
  '../outside',
  'payload-manifest.json',
])
  test(`site payload refuses unmanaged or reserved input ${path}`, (t) => {
    const f = fixture(t);
    f.files.set(path, Buffer.from('bad'));
    assert.throws(() => createSitePayload(f));
  });

test('formal candidate cannot bypass current publication checks or enter the canary path', async (t) => {
  const { planSiteReleaseCandidate, planReleaseCandidate } = await import('./hosting-recovery.mjs');
  const f = fixture(t);
  createSitePayload(f);
  const artifactInput = siteArtifact({ ...f, run: run() });
  assert.throws(
    () => planSiteReleaseCandidate({ artifactInput, currentOwnedPaths: [] }),
    /required/,
  );
  assert.throws(
    () =>
      planSiteReleaseCandidate({ artifactInput, currentOwnedPaths: [], publicProductPaths: [] }),
    /withdrawn/,
  );
  assert.equal(
    planSiteReleaseCandidate({
      artifactInput,
      currentOwnedPaths: [],
      publicProductPaths: ['/products/p-abc/'],
    }).publicOutput.products.length,
    1,
  );
  assert.throws(
    () => planReleaseCandidate({ artifactInput, currentOwnedPaths: [] }),
    /canary-only/,
  );
});
