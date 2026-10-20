import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  planHostingRecovery,
  sealHostingBackup,
  verifyRecoveryInput,
} from './hosting-recovery.mjs';

import { fixture, publicFiles, target } from './release-fixtures.mjs';

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
    'sitemap-index.xml': '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>',
    '__auth/index.html': 'platform',
  });
  const plan = planHostingRecovery({
    ...f,
    target,
    currentOwnedPaths: ['retired/index.html', '_astro/old.hash.js', '__auth/index.html'],
    publicProductPaths: [],
  });
  assert.deepEqual(
    plan.uploads.map((e) => e.path),
    ['_astro/a.hash.js', 'index.html', 'sitemap-index.xml'],
  );
  assert.deepEqual(plan.deletes, ['retired/index.html']);
  assert.equal(plan.preservedPlatformFiles, 1);
});

test('withdrawn products reject the entire old artifact, including its old sitemap', (t) => {
  const f = fixture(t, publicFiles());
  const args = { ...f, target, currentOwnedPaths: [], publicProductPaths: [] };
  assert.throws(() => planHostingRecovery(args), /resurrect a withdrawn product/);
  assert.equal(
    planHostingRecovery({ ...args, publicProductPaths: ['/products/p-abc/'] }).uploads.length,
    6,
  );
});

test('missing current publication/ownership evidence never becomes an empty default', (t) => {
  const f = fixture(t);
  assert.throws(() => planHostingRecovery({ ...f, target }), /required/);
});

test('a withdrawn URL present only in a sitemap still rejects recovery', (t) => {
  const f = fixture(t, {
    'index.html': 'home',
    'sitemap-products.xml':
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://fixture.example/products/p-withdrawn/</loc></url></urlset>',
  });
  assert.throws(
    () => planHostingRecovery({ ...f, target, currentOwnedPaths: [], publicProductPaths: [] }),
    /withdrawn|manifest/i,
  );
});

test('an orphan owned XML with an unknown role cannot silently survive a recovery', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      planHostingRecovery({
        ...f,
        target,
        currentOwnedPaths: ['old-product-map.xml'],
        publicProductPaths: [],
      }),
    /Unclassified.*XML/,
  );
});
