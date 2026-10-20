import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { planReleaseRecovery } from './hosting-recovery.mjs';
import { digest, fixture, target } from './release-fixtures.mjs';
import { verifyReleaseArtifact } from './release/artifact.mjs';

function setup(t, scope = { kind: 'site' }) {
  const root = scope.kind === 'site' ? 'index.html' : `${scope.prefix}index.html`;
  const files = {
    [root]: 'home',
    'compatibility.json': JSON.stringify({ schemaVersion: 1, policy: 'retain-data' }),
  };
  if (scope.kind === 'site') files['snapshot.json'] = JSON.stringify({ products: [] });
  const entry = (path) => ({
    path,
    bytes: Buffer.byteLength(files[path]),
    sha256: digest(files[path]),
  });
  const configuration = { errorDocument: '404.html' };
  files['static-manifest.json'] = JSON.stringify({
    schemaVersion: 2,
    purpose: 'static-release',
    configuration,
    configurationSha256: digest(JSON.stringify(configuration)),
    entries: [entry(root)],
  });
  const payload = {
    schemaVersion: 2,
    purpose: 'release-payload',
    releaseId: 'release-1',
    codeSha: 'a'.repeat(40),
    target: { envId: target.envId, siteOrigin: target.site },
    scope,
    createdAt: '2026-10-20T00:00:00Z',
    entries: Object.keys(files).map(entry),
  };
  files['payload-manifest.json'] = JSON.stringify(payload);
  // The v1 backup fixture requires a homepage; the v2 payload need not list it for canaries.
  const f = fixture(t, { 'index.html': 'fixture-only', ...files });
  const artifact = {
    repository: 'fixture/channel',
    workflowPath: '.github/workflows/release.yml',
    runId: '10',
    artifactId: '20',
    manifestSha256: digest(files['payload-manifest.json']),
    expiresAt: '2026-11-20T00:00:00Z',
  };
  const envelope = {
    schemaVersion: 2,
    releaseId: payload.releaseId,
    codeSha: payload.codeSha,
    target: payload.target,
    scope,
    artifact,
    staticManifestPath: 'static-manifest.json',
    snapshotPath: scope.kind === 'site' ? 'snapshot.json' : null,
    functions: [],
    compatibilityRef: { path: 'compatibility.json', sha256: entry('compatibility.json').sha256 },
  };
  Object.assign(payload, {
    staticManifestPath: envelope.staticManifestPath,
    snapshotPath: envelope.snapshotPath,
    functions: structuredClone(envelope.functions),
    compatibilityRef: structuredClone(envelope.compatibilityRef),
  });
  files['payload-manifest.json'] = JSON.stringify(payload);
  writeFileSync(join(f.directory, 'payload-manifest.json'), files['payload-manifest.json']);
  artifact.manifestSha256 = digest(files['payload-manifest.json']);
  const policy = {
    configurationSha256: digest(JSON.stringify(configuration)),
    repository: artifact.repository,
    workflowPath: artifact.workflowPath,
    event: 'push',
    ref: 'refs/heads/test',
    target: payload.target,
    scope,
  };
  const run = {
    repository: artifact.repository,
    workflowPath: artifact.workflowPath,
    event: policy.event,
    ref: policy.ref,
    headSha: payload.codeSha,
    runId: '10',
    artifact: { id: '20', runId: '10', expired: false, expiresAt: artifact.expiresAt },
  };
  const acceptedSeal = {
    schemaVersion: 1,
    activationId: 'activation-1',
    releaseId: payload.releaseId,
    codeSha: payload.codeSha,
    artifact,
    target: payload.target,
    scope,
  };
  return {
    directory: f.directory,
    envelope: structuredClone(envelope),
    policy: structuredClone(policy),
    run: structuredClone(run),
    acceptedSeal: structuredClone(acceptedSeal),
    now: Date.parse('2026-10-20T01:00:00Z'),
    files,
    payload,
  };
}
function rewritePayload(f) {
  Object.assign(f.payload, {
    staticManifestPath: f.envelope.staticManifestPath,
    snapshotPath: f.envelope.snapshotPath,
    functions: structuredClone(f.envelope.functions),
    compatibilityRef: structuredClone(f.envelope.compatibilityRef),
  });
  const body = JSON.stringify(f.payload);
  writeFileSync(join(f.directory, 'payload-manifest.json'), body);
  f.envelope.artifact.manifestSha256 = digest(body);
  f.acceptedSeal.artifact.manifestSha256 = digest(body);
}

test('candidate is checked before acceptance; recovery requires the matching accepted seal', (t) => {
  const f = setup(t);
  assert.equal(verifyReleaseArtifact(f).mode, 'recovery');
  assert.equal(
    verifyReleaseArtifact({ ...f, mode: 'candidate', acceptedSeal: undefined }).mode,
    'candidate',
  );
  assert.throws(() => verifyReleaseArtifact({ ...f, acceptedSeal: undefined }), /seal/);
});

for (const [name, change] of [
  [
    'repository',
    (f) => {
      f.run.repository = 'attacker/repo';
    },
  ],
  [
    'workflow',
    (f) => {
      f.run.workflowPath = '.github/workflows/other.yml';
    },
  ],
  [
    'branch',
    (f) => {
      f.run.ref = 'refs/heads/other';
    },
  ],
  [
    'event',
    (f) => {
      f.run.event = 'pull_request';
    },
  ],
  [
    'SHA',
    (f) => {
      f.run.headSha = 'b'.repeat(40);
    },
  ],
  [
    'run',
    (f) => {
      f.run.runId = '11';
    },
  ],
  [
    'artifact ID',
    (f) => {
      f.run.artifact.id = '21';
    },
  ],
  [
    'artifact run',
    (f) => {
      f.run.artifact.runId = '11';
    },
  ],
  [
    'expired artifact',
    (f) => {
      f.run.artifact.expired = true;
    },
  ],
  [
    'expired timestamp',
    (f) => {
      f.now = Date.parse('2026-12-20T00:00:00Z');
    },
  ],
  [
    'accepted target',
    (f) => {
      f.acceptedSeal.target.envId = 'other';
    },
  ],
  [
    'accepted artifact',
    (f) => {
      f.acceptedSeal.artifact.artifactId = '21';
    },
  ],
  [
    'accepted release',
    (f) => {
      f.acceptedSeal.releaseId = 'other';
    },
  ],
  [
    'missing source',
    (f) => {
      f.run = { trusted: true };
    },
  ],
  [
    'unknown schema',
    (f) => {
      f.envelope.schemaVersion = 3;
    },
  ],
  [
    'origin',
    (f) => {
      f.envelope.target.siteOrigin += '/';
    },
  ],
]) {
  test(`release rejects wrong ${name}`, (t) => {
    const f = setup(t);
    change(f);
    assert.throws(() => verifyReleaseArtifact(f));
  });
}

test('payload bytes must match the manifest hash and each member identity', (t) => {
  const f = setup(t);
  writeFileSync(join(f.directory, 'index.html'), 'evil');
  assert.throws(() => verifyReleaseArtifact(f), /Corrupt payload file/);
  const g = setup(t);
  writeFileSync(join(g.directory, 'payload-manifest.json'), '{}');
  assert.throws(() => verifyReleaseArtifact(g), /hash mismatch/);
});

for (const [name, change] of [
  [
    'future time',
    (f) => {
      f.payload.createdAt = '2027-01-01T00:00:00Z';
      rewritePayload(f);
    },
  ],
  [
    'missing member',
    (f) => {
      f.payload.entries.pop();
      rewritePayload(f);
    },
  ],
  [
    'duplicate member',
    (f) => {
      f.payload.entries.push(f.payload.entries[0]);
      rewritePayload(f);
    },
  ],
  [
    'unknown payload schema',
    (f) => {
      f.payload.schemaVersion = 1;
      rewritePayload(f);
    },
  ],
  [
    'compatibility hash',
    (f) => {
      f.envelope.compatibilityRef.sha256 = '0'.repeat(64);
    },
  ],
  [
    'function hash',
    (f) => {
      f.envelope.functions = [
        { name: 'api', packagePath: 'index.html', sha256: '0'.repeat(64), runtime: 'Nodejs20.19' },
      ];
    },
  ],
]) {
  test(`release rejects ${name}`, (t) => {
    const f = setup(t);
    change(f);
    assert.throws(() => verifyReleaseArtifact(f));
  });
}

test('canary payload has its own entry, fixed target prefix and no homepage requirement', (t) => {
  const f = setup(t, { kind: 'canary', prefix: '__release-canary/' });
  assert.equal(
    verifyReleaseArtifact(f).staticManifest.entries[0].path,
    '__release-canary/index.html',
  );
});

test('canary cannot expand the trusted prefix or carry site/functions/snapshot members', (t) => {
  for (const change of [
    (f) => {
      f.envelope.scope.prefix = 'other/';
    },
    (f) => {
      f.envelope.functions.push({ name: 'api' });
    },
    (f) => {
      f.envelope.snapshotPath = 'snapshot.json';
    },
    (f) => {
      f.policy.scope = { kind: 'site' };
    },
  ]) {
    const f = setup(t, { kind: 'canary', prefix: '__release-canary/' });
    change(f);
    assert.throws(() => verifyReleaseArtifact(f));
  }
});

test('v2 canary plan and executor cannot claim ownership outside its configured prefix', (t) => {
  const f = setup(t, { kind: 'canary', prefix: '__release-canary/' });
  const plan = planReleaseRecovery({
    artifactInput: f,
    currentOwnedPaths: ['__release-canary/retired.html'],
    publicProductPaths: [],
  });
  assert.deepEqual(
    plan.uploads.map((entry) => entry.path),
    ['__release-canary/index.html'],
  );
  assert.deepEqual(plan.deletes, ['__release-canary/retired.html']);
  assert.throws(
    () =>
      planReleaseRecovery({
        artifactInput: f,
        currentOwnedPaths: ['index.html'],
        publicProductPaths: [],
      }),
    /scope/,
  );
  f.policy.configurationSha256 = '0'.repeat(64);
  assert.throws(() => verifyReleaseArtifact(f), /configuration/);
});

test('an omitted compatibility hash cannot silently weaken the payload contract', (t) => {
  const f = setup(t);
  f.envelope.compatibilityRef.sha256 = undefined;
  assert.throws(() => verifyReleaseArtifact(f), /compatibility/);
});

test('a function package is pinned to its exact payload bytes and accepted source', (t) => {
  const f = setup(t);
  const body = 'fixture-function-package';
  writeFileSync(join(f.directory, 'function.tgz'), body);
  f.payload.entries.push({
    path: 'function.tgz',
    bytes: Buffer.byteLength(body),
    sha256: digest(body),
  });
  f.envelope.functions.push({
    name: 'catalog-api',
    packagePath: 'function.tgz',
    sha256: digest(body),
    runtime: 'Nodejs20.19',
  });
  rewritePayload(f);
  assert.equal(verifyReleaseArtifact(f).envelope.functions.length, 1);
  writeFileSync(join(f.directory, 'function.tgz'), 'wrong-package');
  assert.throws(() => verifyReleaseArtifact(f), /Corrupt payload/);
});

test('component descriptors are pinned by the payload hash, including the function runtime', (t) => {
  const f = setup(t);
  f.envelope.snapshotPath = 'compatibility.json';
  assert.throws(() => verifyReleaseArtifact(f), /descriptor|identity/);
  const g = setup(t);
  g.envelope.staticManifestPath = 'compatibility.json';
  assert.throws(() => verifyReleaseArtifact(g), /descriptor|identity/);
});

test('canary rejects custom XML discovery even when all payload hashes match', (t) => {
  const f = setup(t, { kind: 'canary', prefix: '__release-canary/' });
  const path = '__release-canary/custom.xml';
  const body = '<urlset/>';
  writeFileSync(join(f.directory, path), body);
  const entry = { path, bytes: Buffer.byteLength(body), sha256: digest(body) };
  const staticManifest = JSON.parse(f.files['static-manifest.json']);
  staticManifest.entries.push(entry);
  const staticBody = JSON.stringify(staticManifest);
  writeFileSync(join(f.directory, 'static-manifest.json'), staticBody);
  Object.assign(
    f.payload.entries.find((e) => e.path === 'static-manifest.json'),
    { bytes: Buffer.byteLength(staticBody), sha256: digest(staticBody) },
  );
  f.payload.entries.push(entry);
  rewritePayload(f);
  assert.throws(() => verifyReleaseArtifact(f), /scope/);
});

test('a function descriptor requires its own hash even if the envelope matches the payload', (t) => {
  const f = setup(t);
  const body = 'fixture-function-package';
  writeFileSync(join(f.directory, 'function.tgz'), body);
  f.payload.entries.push({
    path: 'function.tgz',
    bytes: Buffer.byteLength(body),
    sha256: digest(body),
  });
  f.envelope.functions.push({
    name: 'catalog-api',
    packagePath: 'function.tgz',
    runtime: 'Nodejs20.19',
  });
  rewritePayload(f);
  assert.throws(() => verifyReleaseArtifact(f), /function descriptor/);
});
