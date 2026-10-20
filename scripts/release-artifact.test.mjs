import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { planHostingRecovery, verifyRecoveryInput } from './hosting-recovery.mjs';
import { fixture, publicFiles, target, xml } from './release-fixtures.mjs';

const plan = (f, paths = ['/products/p-abc/']) =>
  planHostingRecovery({ ...f, target, currentOwnedPaths: [], publicProductPaths: paths });

test('all public projections agree; sitemap index references are not product URLs', (t) => {
  const result = plan(fixture(t, publicFiles()));
  assert.equal(result.uploads.length, 6);
  assert.equal(result.publicOutput.products[0].path, '/products/p-abc/');
  assert.equal(result.publicOutput.products[0].revision, 'r1');
});

test('empty products require a coherent explicit empty projection', (t) => {
  assert.equal(plan(fixture(t, publicFiles([])), []).publicOutput.products.length, 0);
});

test('legacy v1 homepage-only backup remains readable and plannable', (t) => {
  const f = fixture(t);
  verifyRecoveryInput(f.manifest, f.directory, target);
  assert.equal(plan(f, []).uploads.length, 2);
});

for (const location of ['html', 'products', 'seo', 'sitemap']) {
  test(`withdrawn product advertised only in ${location} rejects the entire artifact`, (t) => {
    const files = publicFiles([]);
    if (location === 'html') files['products/p-gone/index.html'] = 'gone';
    if (location === 'products')
      files['products/manifest.json'] = JSON.stringify({
        schemaVersion: 1,
        purpose: 'public',
        siteOrigin: target.site,
        total: 1,
        products: [{ path: '/products/p-gone/', revision: 'old' }],
      });
    if (location === 'seo')
      files['seo-manifest.json'] = JSON.stringify({
        schemaVersion: 1,
        siteOrigin: target.site,
        entries: [{ path: '/products/p-gone/', kind: 'product' }],
      });
    if (location === 'sitemap') files['sitemap-0.xml'] = xml(['/products/p-gone/']);
    assert.throws(() => plan(fixture(t, files), []), /withdrawn/);
  });
}

for (const path of [
  'products/manifest.json',
  'seo-manifest.json',
  'sitemap-0.xml',
  'products/p-abc/index.html',
]) {
  test(`missing ${path} cannot pass a coherent product recovery`, (t) => {
    const files = publicFiles();
    delete files[path];
    assert.throws(() => plan(fixture(t, files)), /manifest|sitemap|projection/i);
  });
}

for (const [name, body] of [
  ['truncated', '<urlset'],
  [
    'DTD',
    '<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>',
  ],
  [
    'unknown entity',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>&bad;</loc></url></urlset>',
  ],
  ['foreign namespace', '<urlset xmlns="https://invalid.example"/>'],
  ['duplicate URL', xml(['/products/p-abc/', '/products/p-abc/'])],
  ['foreign origin', xml(['/products/p-abc/']).replaceAll(target.site, 'https://other.example')],
  ['query URL', xml(['/products/p-abc/?variant=x'])],
  ['encoded path', xml(['/products/%70-abc/'])],
  [
    'nested loc',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><lastmod><loc>https://fixture.example/products/p-abc/</loc></lastmod></url></urlset>',
  ],
  ['oversized XML', ' '.repeat(5 * 1024 * 1024 + 1)],
  [
    'deep XML',
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${'<extra>'.repeat(40)}${'</extra>'.repeat(40)}</urlset>`,
  ],
]) {
  test(`sitemap rejects ${name}`, (t) => {
    const files = publicFiles();
    files['sitemap-0.xml'] = body;
    assert.throws(() => plan(fixture(t, files)), /sitemap|XML|URL|limit|namespace/i);
  });
}

test('sitemap index cycles and duplicate fragment references reject locally', (t) => {
  const files = publicFiles();
  files['sitemap-0.xml'] = files['sitemap-index.xml'].replace('sitemap-0.xml', 'sitemap-index.xml');
  assert.throws(() => plan(fixture(t, files)), /cycle/);
  files['sitemap-0.xml'] = xml(['/products/p-abc/']);
  files['sitemap-index.xml'] = files['sitemap-index.xml'].replace(
    '</sitemapindex>',
    `<sitemap><loc>${target.site}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
  );
  assert.throws(() => plan(fixture(t, files)), /duplicate/i);
});

for (const [name, change] of [
  [
    'wrong origin',
    (p) => {
      p.siteOrigin = 'https://wrong.example';
    },
  ],
  [
    'unknown schema',
    (p) => {
      p.schemaVersion = 2;
    },
  ],
  [
    'wrong total',
    (p) => {
      p.total = 10;
    },
  ],
  [
    'duplicate product',
    (p) => {
      p.products.push(p.products[0]);
      p.total++;
    },
  ],
  [
    'missing revision',
    (p) => {
      p.products[0].revision = undefined;
    },
  ],
]) {
  test(`product manifest rejects ${name}`, (t) => {
    const files = publicFiles();
    const parsed = JSON.parse(files['products/manifest.json']);
    change(parsed);
    files['products/manifest.json'] = JSON.stringify(parsed);
    assert.throws(() => plan(fixture(t, files)), /manifest|origin|duplicate|revision/i);
  });
}

test('invalid JSON and oversized metadata reject', (t) => {
  for (const value of ['{', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    const files = publicFiles();
    files['seo-manifest.json'] = value;
    assert.throws(() => plan(fixture(t, files)), /JSON|limit|manifest/i);
  }
});

test('root and intermediate symlinks cannot enter recovery input', (t) => {
  const f = fixture(t, publicFiles());
  symlinkSync(f.directory, join(f.directory, 'alias'));
  assert.throws(
    () => verifyRecoveryInput(f.manifest, join(f.directory, 'alias'), target),
    /Symlink/,
  );
  rmSync(join(f.directory, 'products'), { recursive: true });
  symlinkSync('elsewhere', join(f.directory, 'products'));
  assert.throws(() => verifyRecoveryInput(f.manifest, f.directory, target), /Symlink/);
});

test('manifest cannot contain an unbounded file even before reading it', (t) => {
  const f = fixture(t);
  f.manifest.entries[0].bytes = 129 * 1024 * 1024;
  assert.throws(() => verifyRecoveryInput(f.manifest, f.directory, target), /limit/);
});

test('correct bytes alone do not make a directory into a file', (t) => {
  const f = fixture(t);
  rmSync(join(f.directory, 'index.html'));
  symlinkSync('_astro', join(f.directory, 'index.html'));
  assert.throws(() => verifyRecoveryInput(f.manifest, f.directory, target), /Symlink|regular/);
});

test('a changed file fails even when the manifest still points at the original hash', (t) => {
  const f = fixture(t, publicFiles());
  writeFileSync(join(f.directory, 'sitemap-0.xml'), xml([]));
  assert.throws(() => plan(f), /Corrupt/);
});

test('sitemap fragments may use a different XML filename; missing referenced fragments fail', (t) => {
  const files = publicFiles();
  files['product-pages.xml'] = files['sitemap-0.xml'];
  Reflect.deleteProperty(files, 'sitemap-0.xml');
  files['sitemap-index.xml'] = files['sitemap-index.xml'].replace(
    'sitemap-0.xml',
    'product-pages.xml',
  );
  assert.equal(plan(fixture(t, files)).publicOutput.products.length, 1);
  Reflect.deleteProperty(files, 'product-pages.xml');
  assert.throws(() => plan(fixture(t, files)), /sitemap/);
});

test('robots sitemap references participate in the same local consistency check', (t) => {
  const files = {
    'index.html': 'home',
    'robots.txt': `User-agent: *\nSitemap: ${target.site}/extra-map.xml\n`,
    'extra-map.xml': xml(['/products/p-gone/']),
  };
  assert.throws(() => plan(fixture(t, files), []), /withdrawn/);
});

test('noncanonical product URLs cannot hide as ordinary sitemap pages', (t) => {
  assert.throws(
    () =>
      plan(
        fixture(t, { 'index.html': 'home', 'sitemap-0.xml': xml(['/products/p-gone/index.html']) }),
        [],
      ),
    /canonical|product/,
  );
});

test('CLI produces a local plan without cloud credentials or overwriting its input', (t) => {
  const f = fixture(t, publicFiles());
  const inputs = {
    'backup.json': f.manifest,
    'owned.json': [],
    'public.json': ['/products/p-abc/'],
  };
  for (const [file, value] of Object.entries(inputs))
    writeFileSync(join(f.directory, file), JSON.stringify(value));
  const args = [
    new URL('./prepare-hosting-recovery.mjs', import.meta.url).pathname,
    '--manifest',
    join(f.directory, 'backup.json'),
    '--directory',
    f.directory,
    '--env',
    target.envId,
    '--site',
    target.site,
    '--current-owned',
    join(f.directory, 'owned.json'),
    '--public-products',
    join(f.directory, 'public.json'),
    '--report',
    join(f.directory, 'plan.json'),
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'plan.json'), 'utf8')).schemaVersion, 2);
  const again = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /EEXIST/);
  args[args.indexOf('--env') + 1] = 'other-env';
  args[args.indexOf('--report') + 1] = join(f.directory, 'wrong-plan.json');
  const wrong = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(wrong.status, 0);
  assert.equal(existsSync(join(f.directory, 'wrong-plan.json')), false);
});

test('custom sitemap fragments upload after HTML, never as dependency assets', (t) => {
  const files = publicFiles();
  files['custom.xml'] = files['sitemap-0.xml'];
  Reflect.deleteProperty(files, 'sitemap-0.xml');
  files['sitemap-index.xml'] = files['sitemap-index.xml'].replace('sitemap-0.xml', 'custom.xml');
  const uploads = plan(fixture(t, files)).uploads.map((entry) => entry.path);
  assert.ok(uploads.indexOf('custom.xml') > uploads.indexOf('products/p-abc/index.html'));
});
