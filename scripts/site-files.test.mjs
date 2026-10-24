import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from './release/input.mjs';
import {
  assertPublicSiteDeliveryFiles,
  assertSameAcceptedBlog,
  filesFromHostingBackup,
  filesFromSiteBuild,
  ownedSitePaths,
  retainSiteAssets,
} from './release/site-files.mjs';
function source(t, files) {
  const directory = mkdtempSync(join(tmpdir(), 'site-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entries = [];
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), body);
    entries.push({ path, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)) });
  }
  return { directory, staticManifest: { entries } };
}
test('baseline adopts only static files and leaves ownership, platform history and extensionless legacy objects alone', (t) => {
  const f = source(t, {
    'index.html': 'A',
    'legacy-product': 'legacy',
    'google123.html': 'owner',
    'BingSiteAuth.xml': 'owner',
    '__audit/report.html': 'private',
    '_admin-audit-session/index.html': 'other workstream',
    'cloud-admin/index.html': 'platform',
    '.cloudbase-backup/old.html': 'old',
    '_astro/old.js': 'js',
    'catalog/index.html': 'catalog',
  });
  const files = filesFromHostingBackup(f.staticManifest, f.directory);
  assert.deepEqual([...files.keys()], ['index.html', '_astro/old.js', 'catalog/index.html']);
});
test('candidate retains old assets for open browsers; only exact owned HTML/discovery can be removed', (t) => {
  const a = source(t, {
    'index.html': 'A',
    '_astro/old.js': 'Ajs',
    'blog/previous/index.html': 'Aarticle',
    'sitemap-0.xml': 'Axml',
  });
  const files = retainSiteAssets(
    new Map([
      ['index.html', Buffer.from('B')],
      ['_astro/new.js', Buffer.from('Bjs')],
    ]),
    a,
  );
  assert(files.has('_astro/old.js'));
  assert(!files.has('blog/previous/index.html'));
  const b = source(t, Object.fromEntries(files));
  assert.deepEqual(
    ownedSitePaths(b, a).sort(),
    [
      'index.html',
      '_astro/old.js',
      'blog/previous/index.html',
      'sitemap-0.xml',
      '_astro/new.js',
    ].sort(),
  );
  assert.throws(
    () => retainSiteAssets(new Map([['_astro/old.js', Buffer.from('changed')]]), a),
    /Immutable/,
  );
});
test('build input refuses links and unrecognized members before archive or cloud mutation', (t) => {
  const f = source(t, {
    'index.html': 'home',
    'errors/not-found.html': '404',
    'secret.env': 'bad',
  });
  assert.throws(() => filesFromSiteBuild(f.directory), /Unmanaged/);
  rmSync(join(f.directory, 'secret.env'));
  symlinkSync('/etc/passwd', join(f.directory, 'linked.txt'));
  assert.throws(() => filesFromSiteBuild(f.directory), /Link/);
});
test('static recovery cannot silently roll back accepted Blog content while keeping newer database state', (t) => {
  const manifest = (revision) =>
    JSON.stringify({ entries: [{ path: '/blog/one/', kind: 'article', content: { revision } }] });
  const a = source(t, { 'seo-manifest.json': manifest('1') });
  const b = source(t, { 'seo-manifest.json': manifest('2') });
  assert.throws(() => assertSameAcceptedBlog(a, b), /disagree/);
  assert.doesNotThrow(() => assertSameAcceptedBlog(a, a));
});
test('public site retains assistant integration and never exposes server settings', () => {
  assert.doesNotThrow(() =>
    assertPublicSiteDeliveryFiles(
      new Map([['index.html', Buffer.from('https://assistant.example')]]),
      'https://assistant.example',
    ),
  );
  assert.throws(
    () =>
      assertPublicSiteDeliveryFiles(
        new Map([['index.html', Buffer.from('no assistant')]]),
        'https://assistant.example',
      ),
    /missing/,
  );
  assert.throws(
    () =>
      assertPublicSiteDeliveryFiles(
        new Map([['index.html', Buffer.from('JWT_SECRET https://assistant.example')]]),
        'https://assistant.example',
      ),
    /Server-only/,
  );
});
