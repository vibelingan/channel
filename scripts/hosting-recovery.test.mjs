import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  executeHostingRecovery,
  planHostingRecovery,
  sealHostingBackup,
  verifyRecoveryInput,
} from './hosting-recovery.mjs';

const target = { envId: 'fixture-env', site: 'https://fixture.example' };
function fixture(t, files = { 'index.html': 'home', '_astro/a.hash.js': 'script' }) {
  const directory = mkdtempSync(join(tmpdir(), 'hosting-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entries = Object.entries(files).map(([path, body]) => {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), body);
    return {
      path,
      bytes: Buffer.byteLength(body),
      etag: `"${createHash('md5').update(body).digest('hex')}"`,
      lastModified: '2026-10-20T00:00:00Z',
    };
  });
  const before = { ...target, entries };
  const configBefore = {
    website: { WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } } },
    gateway: { Domains: [{ Domain: 'fixture.example' }] },
  };
  const inputs = {
    directory,
    before,
    after: structuredClone(before),
    configBefore,
    configAfter: structuredClone(configBefore),
  };
  return { ...inputs, manifest: sealHostingBackup(inputs) };
}

test('backup pins all bytes to both stable inventories and object ETags', (t) => {
  const f = fixture(t);
  verifyRecoveryInput(f.manifest, f.directory, target);
  f.after.entries[0].etag = 'changed';
  assert.throws(() => sealHostingBackup(f), /changed during backup/);
});

test('a successful download is insufficient if any local file was truncated or altered', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'index.html'), 'evil'); // same byte length
  assert.throws(() => sealHostingBackup(f), /ETag mismatch/);
  assert.throws(() => verifyRecoveryInput(f.manifest, f.directory, target), /Corrupt/);
});

test('request IDs may change but route configuration must remain identical', (t) => {
  const f = fixture(t);
  f.configBefore.gateway.RequestId = 'before';
  f.configAfter.gateway.RequestId = 'after';
  sealHostingBackup(f);
  f.configAfter.gateway.Domains[0].AccessType = 'CDN';
  assert.throws(() => sealHostingBackup(f), /changed during backup/);
});

test('multipart ETags require a matching independent content read, never an assumed MD5', (t) => {
  const f = fixture(t);
  f.before.entries[0].etag = '"multipart-etag-7"';
  f.after = structuredClone(f.before);
  assert.throws(() => sealHostingBackup(f), /Cannot prove/);
  const entry = f.before.entries[0];
  const proof = {
    path: entry.path,
    bytes: entry.bytes,
    etag: entry.etag,
    sha256: createHash('sha256').update('home').digest('hex'),
  };
  sealHostingBackup({ ...f, contentProofs: [proof] });
  assert.throws(
    () => sealHostingBackup({ ...f, contentProofs: [{ ...proof, etag: 'other' }] }),
    /Cannot prove/,
  );
});

test('corrupt, wrong-environment and traversal inputs fail before adapters run', (t) => {
  const f = fixture(t);
  assert.throws(
    () => verifyRecoveryInput(f.manifest, f.directory, { ...target, envId: 'other' }),
    /wrong-environment/,
  );
  f.manifest.entries[0].path = '../index.html';
  assert.throws(() => verifyRecoveryInput(f.manifest, f.directory, target), /Invalid hosting/);
});

test('symlinks cannot substitute files even with matching bytes', (t) => {
  const f = fixture(t);
  rmSync(join(f.directory, 'index.html'));
  writeFileSync(join(f.directory, 'replacement.html'), 'home');
  symlinkSync('replacement.html', join(f.directory, 'index.html'));
  assert.throws(() => verifyRecoveryInput(f.manifest, f.directory, target), /Symlink/);
});

test('restore orders assets before HTML and discovery; preserves platform files and old assets', (t) => {
  const f = fixture(t, {
    'index.html': 'home',
    '_astro/a.hash.js': 'script',
    'sitemap-index.xml': 'sitemap',
    '__auth/index.html': 'platform',
    'products/manifest.json': '{}',
  });
  const plan = planHostingRecovery({
    ...f,
    target,
    currentOwnedPaths: ['retired/index.html', '_astro/old.hash.js', '__auth/index.html'],
    publicProductPaths: [],
  });
  assert.deepEqual(
    plan.uploads.map((e) => e.path),
    ['_astro/a.hash.js', 'index.html', 'products/manifest.json', 'sitemap-index.xml'],
  );
  assert.deepEqual(plan.deletes, ['retired/index.html']);
  assert.equal(plan.preservedPlatformFiles, 1);
});

test('withdrawn products reject the entire old artifact, including its old sitemap', (t) => {
  const f = fixture(t, { 'index.html': 'home', 'products/p-abc/index.html': 'product' });
  const args = { ...f, target, currentOwnedPaths: [], publicProductPaths: [] };
  assert.throws(() => planHostingRecovery(args), /resurrect a withdrawn product/);
  assert.equal(
    planHostingRecovery({ ...args, publicProductPaths: ['/products/p-abc/'] }).uploads.length,
    2,
  );
});

test('missing current publication/ownership evidence never becomes an empty default', (t) => {
  const f = fixture(t);
  assert.throws(() => planHostingRecovery({ ...f, target }), /required/);
});

test('interrupted dependency upload cannot advance to page overwrite, prune or configuration', async () => {
  const calls = [];
  await assert.rejects(
    executeHostingRecovery(
      {
        uploads: [{ path: '_astro/a.js' }, { path: 'index.html' }],
        deletes: ['retired/index.html'],
      },
      {
        upload: async (entry) => calls.push(`upload:${entry.path}`),
        verify: async () => {
          throw new Error('read-back mismatch');
        },
        remove: async () => calls.push('remove'),
        configure: async () => calls.push('configure'),
        accept: async () => calls.push('accept'),
      },
    ),
    /read-back mismatch/,
  );
  assert.deepEqual(calls, ['upload:_astro/a.js']);
});

test('a recovery is complete only after ordinary URL acceptance succeeds', async () => {
  const calls = [];
  await assert.rejects(
    executeHostingRecovery(
      { uploads: [], deletes: [] },
      {
        upload: async () => {},
        verify: async () => {},
        remove: async () => {},
        configure: async () => calls.push('configure'),
        accept: async () => {
          calls.push('accept');
          throw new Error('stale ordinary URL');
        },
      },
    ),
    /stale ordinary URL/,
  );
  assert.deepEqual(calls, ['configure', 'accept']);
});
