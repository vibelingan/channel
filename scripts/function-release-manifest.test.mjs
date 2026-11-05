import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  expectedFunctionRelease,
  functionReleaseManifest,
  readFunctionReleaseManifest,
  writeFunctionReleaseManifest,
} from './function-release-manifest.mjs';

const deployed = 'b'.repeat(40);
const earlier = 'a'.repeat(40);

test('a kept function must still report its earlier build, and every function this deploy', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'function-releases-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'releases.json');
  writeFunctionReleaseManifest(
    path,
    functionReleaseManifest(deployed, {
      admin: { releaseId: deployed, code: 'uploaded' },
      'alibaba-catalog-sync': { releaseId: earlier, code: 'unchanged' },
    }),
  );
  const manifest = readFunctionReleaseManifest(path, deployed);
  assert.deepEqual(expectedFunctionRelease(manifest, 'admin', deployed), {
    releaseId: deployed,
    deployedReleaseId: deployed,
  });
  assert.deepEqual(expectedFunctionRelease(manifest, 'alibaba-catalog-sync', deployed), {
    releaseId: earlier,
    deployedReleaseId: deployed,
  });
  assert.throws(() => readFunctionReleaseManifest(path, 'c'.repeat(40)), /another deploy/);
});

test('without a manifest every function must report this commit, as before', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'function-releases-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = readFunctionReleaseManifest(join(directory, 'absent.json'), deployed);
  assert.equal(manifest, null);
  assert.deepEqual(expectedFunctionRelease(manifest, 'public-api', deployed), {
    releaseId: deployed,
    deployedReleaseId: undefined,
  });
});

test('an uploaded function cannot report another build, and unknown entries are refused', (t) => {
  for (const functions of [
    { admin: { releaseId: earlier, code: 'uploaded' } },
    { admin: { releaseId: 'local', code: 'unchanged' } },
    { admin: { releaseId: earlier, code: 'skipped' } },
    { 'other-function': { releaseId: deployed, code: 'uploaded' } },
  ])
    assert.throws(() => functionReleaseManifest(deployed, functions));
  assert.throws(() => functionReleaseManifest('local', {}));
  const directory = mkdtempSync(join(tmpdir(), 'function-releases-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'releases.json');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      deployedReleaseId: deployed,
      functions: { admin: { releaseId: earlier, code: 'uploaded' } },
    }),
  );
  assert.throws(() => readFunctionReleaseManifest(path, deployed));
});
