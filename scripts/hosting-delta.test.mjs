import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { selectChangedHostingFiles, verifyRetainedHostingFiles } from './hosting-delta.mjs';
import { planHostingRecovery, recoveryStateIdentity } from './hosting-recovery.mjs';
import { fixture, target } from './release-fixtures.mjs';
const md5 = (body) => `"${createHash('md5').update(body).digest('hex')}"`;
test('unchanged bytes remain in the accepted site identity while only changed files are uploaded', (t) => {
  const f = fixture(t);
  const plan = planHostingRecovery({ ...f, target, currentOwnedPaths: [], publicProductPaths: [] });
  const metadata = plan.uploads.map((e) => ({
    path: e.path,
    bytes: e.bytes,
    etag: md5(e.path === 'index.html' ? 'home' : 'asset'),
    lastModified: '2026-10-24T00:00:00Z',
  }));
  // Use the actual fixture bytes, never infer equality from a file name.
  for (const e of metadata) e.etag = md5(readFileSync(join(f.directory, e.path)));
  const delta = selectChangedHostingFiles({ plan, directory: f.directory, inventory: metadata });
  assert.equal(delta.uploads.length, 0);
  assert.equal(delta.retained.length, plan.uploads.length);
  assert.equal(recoveryStateIdentity(delta), plan.stateSha256);
  verifyRetainedHostingFiles(delta.retained, metadata);
  const changed = structuredClone(metadata);
  changed[0].etag = md5('changed');
  assert.throws(() => verifyRetainedHostingFiles(delta.retained, changed), /changed/);
});
test('matching size without a matching MD5 is uploaded and corrupt local bytes stop before delivery', (t) => {
  const f = fixture(t);
  const plan = planHostingRecovery({ ...f, target, currentOwnedPaths: [], publicProductPaths: [] });
  const metadata = plan.uploads.map((e) => ({
    path: e.path,
    bytes: e.bytes,
    etag: '"multipart-2"',
    lastModified: '2026-10-24T00:00:00Z',
  }));
  const delta = selectChangedHostingFiles({ plan, directory: f.directory, inventory: metadata });
  assert.equal(delta.retained.length, 0);
  writeFileSync(join(f.directory, 'index.html'), 'corrupt');
  assert.throws(
    () => selectChangedHostingFiles({ plan, directory: f.directory, inventory: metadata }),
    /Corrupt/,
  );
});
