import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFunctionGithubSource } from './release/function-github-source.mjs';
import { sha256 } from './release/input.mjs';
const policy = {
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
  repository: 'fixture/channel',
  workflowPath: '.github/workflows/seo-static-canary.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
};
function archive(files) {
  const r = spawnSync(
    'python3',
    [
      '-c',
      "import io,json,sys,zipfile;b=io.BytesIO();z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED);[(z.writestr(k,v)) for k,v in json.load(sys.stdin)];z.close();sys.stdout.buffer.write(b.getvalue())",
    ],
    { input: JSON.stringify(Object.entries(files)), maxBuffer: 4194304 },
  );
  assert.equal(r.status, 0);
  return r.stdout;
}
function setup(
  zip = archive({
    'payload-manifest.json': JSON.stringify({
      schemaVersion: 1,
      purpose: 'function-compatibility-payload',
    }),
    'compatibility.json': '{}',
  }),
) {
  const artifact = {
    id: 22,
    name: 'function-release-payload-11-1',
    expired: false,
    expires_at: '2027-01-01T00:00:00Z',
    size_in_bytes: zip.length,
    digest: `sha256:${sha256(zip)}`,
    workflow_run: {
      id: 11,
      repository_id: 7,
      head_repository_id: 7,
      head_sha: 'b'.repeat(40),
      head_branch: 'feat/seo-foundation',
    },
  };
  const run = {
    id: 11,
    run_attempt: 1,
    path: policy.workflowPath,
    event: 'workflow_dispatch',
    head_branch: 'feat/seo-foundation',
    head_sha: 'b'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    repository: { id: 7, full_name: policy.repository },
    head_repository: { id: 7, full_name: policy.repository },
  };
  const calls = [];
  const request = async (_method, url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://signed.example')) return { status: 200, body: zip };
    if (url.endsWith('/zip'))
      return { status: 302, headers: new Headers({ location: 'https://signed.example/archive' }) };
    return {
      status: 200,
      body: Buffer.from(JSON.stringify(url.includes('/artifacts/') ? artifact : run)),
    };
  };
  return {
    artifact,
    run,
    calls,
    source: createFunctionGithubSource({ policy, token: 'test-private-token', request }),
  };
}
test('function archive validates actual digest, exact attempt and data-only members without forwarding credentials', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'function-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = setup();
  const r = await f.source.download('22', join(root, 'payload'));
  assert.equal(r.run.artifact.id, '22');
  assert(f.calls.some((x) => x.url.includes('/runs/11/attempts/1')));
  const storage = f.calls.find((x) => x.url.startsWith('https://signed.example'));
  assert.equal(storage.opts.headers, undefined);
  assert.equal(storage.opts.redirect, 'error');
  assert.equal(r.evidenceSource.manifestSha256, r.manifestSha256);
});
for (const [name, change] of [
  [
    'wrong producer',
    (f) => {
      f.run.path = '.github/workflows/other.yml';
    },
  ],
  [
    'failed producer',
    (f) => {
      f.run.conclusion = 'failure';
    },
  ],
  [
    'foreign ref',
    (f) => {
      f.run.head_branch = 'main';
    },
  ],
  [
    'expired',
    (f) => {
      f.artifact.expired = true;
    },
  ],
  [
    'missing digest',
    (f) => {
      f.artifact.digest = null;
    },
  ],
  [
    'static artifact',
    (f) => {
      f.artifact.name = 'static-canary-payload-11-1';
    },
  ],
  [
    'wrong SHA',
    (f) => {
      f.run.head_sha = 'c'.repeat(40);
    },
  ],
  [
    'foreign repo',
    (f) => {
      f.run.head_repository.id = 9;
    },
  ],
])
  test(`function source rejects ${name}`, async () => {
    const f = setup();
    change(f);
    await assert.rejects(f.source.metadata('22', 'payload'));
    assert(!f.calls.some((x) => x.url.startsWith('https://signed.example')));
  });
for (const [name, files] of [
  [
    'extra file',
    {
      'payload-manifest.json': '{"schemaVersion":1,"purpose":"function-compatibility-payload"}',
      'compatibility.json': '{}',
      'run.mjs': 'throw 1',
    },
  ],
  ['traversal', { '../escaped': 'bad', 'payload-manifest.json': '{}' }],
  ['unexpected manifest', { 'payload-manifest.json': '{}' }],
])
  test(`extraction refuses ${name} without executing archive code`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'function-source-bad-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const f = setup(archive(files));
    await assert.rejects(f.source.download('22', join(root, 'payload')), /extraction/);
    assert(!existsSync(join(root, 'escaped')));
  });
test('a digest mismatch rejects before any extraction', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'function-source-digest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = setup();
  f.artifact.digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(f.source.download('22', join(root, 'payload')), /digest/);
  assert(!existsSync(join(root, 'payload')));
});

test('an accepted function survives a later producer failure only with its exact saved manifest', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'function-source-sealed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = setup();
  f.run.conclusion = 'failure';
  const seal = {
    schemaVersion: 1,
    activationId: 'accepted-function',
    releaseId: 'dummy-A',
    codeSha: f.run.head_sha,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    scope: { kind: 'site' },
    artifact: {
      repository: policy.repository,
      workflowPath: policy.workflowPath,
      runId: '11',
      artifactId: '22',
      expiresAt: f.artifact.expires_at,
      manifestSha256: sha256(
        JSON.stringify({ schemaVersion: 1, purpose: 'function-compatibility-payload' }),
      ),
    },
  };
  await assert.rejects(f.source.download('22', join(root, 'unsealed')));
  const accepted = await f.source.download('22', join(root, 'accepted'), 'payload', {
    acceptedSeal: seal,
  });
  assert.equal(accepted.manifestSha256, seal.artifact.manifestSha256);
  await assert.rejects(
    f.source.download('22', join(root, 'mismatch'), 'payload', {
      acceptedSeal: { ...seal, artifact: { ...seal.artifact, manifestSha256: '0'.repeat(64) } },
    }),
    /differs from its journal seal/,
  );
  for (const mutation of [
    { ...seal, target: { ...seal.target, envId: 'foreign' } },
    { ...seal, scope: { kind: 'canary' } },
    { ...seal, artifact: { ...seal.artifact, artifactId: '23' } },
  ])
    await assert.rejects(f.source.metadata('22', 'payload', { acceptedSeal: mutation }));
  f.artifact.name = 'function-compatibility-tests-11-1';
  await assert.rejects(f.source.metadata('22', 'tests', { acceptedSeal: seal }));
});
