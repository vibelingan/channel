import assert from 'node:assert/strict';
import test from 'node:test';
import { planHostingRecovery } from './hosting-recovery.mjs';
import { fixture, publicFiles, target, xml } from './release-fixtures.mjs';
import { categoryManifestPath } from './release/category-output.mjs';
import { hostingFilePhase } from './release/hosting-batches.mjs';
import { readPublicOutput } from './release/public-output.mjs';
import { retainSiteAssets } from './release/site-files.mjs';

const families = ['headphones', 'ai-gadgets', 'toys', 'misc'];
function categoryFiles(count = 13) {
  const ids = Array.from({ length: count }, (_, index) => `id-${String(index).padStart(3, '0')}`);
  const productPaths = ids.map((id) => `/products/p-${id}/`);
  const files = publicFiles(productPaths);
  const pages = families.flatMap((family) => {
    const products = family === 'headphones' ? ids : [];
    return Array.from({ length: Math.max(1, Math.ceil(products.length / 12)) }, (_, index) => ({
      family,
      page: index + 1,
      total: products.length,
      path: `/${family}/${index ? `page/${index + 1}/` : ''}`,
      revision: 'a'.repeat(64),
      productIds: products.slice(index * 12, (index + 1) * 12),
    }));
  });
  for (const row of pages) {
    const links = row.productIds
      .map((id) => `<a data-product-card="${id}" href="/products/p-${id}/">Product ${id}</a>`)
      .join('');
    const adjacent = pages.filter(
      (other) => other.family === row.family && Math.abs(other.page - row.page) === 1,
    );
    files[`${row.path.slice(1)}index.html`] =
      `<!doctype html><html><head><meta name="description" content="Models"><link rel="canonical" href="${target.site}${row.path}"></head><body><main><h1>Models</h1>${links}<nav aria-label="Pagination">${adjacent.map((other) => `<a href="${other.path}">Next or previous</a>`).join('')}</nav></main></body></html>`;
  }
  files[categoryManifestPath] = JSON.stringify({
    schemaVersion: 1,
    purpose: 'public',
    siteOrigin: target.site,
    pages,
  });
  const seo = JSON.parse(files['seo-manifest.json']);
  seo.entries.push(
    ...pages.map(({ path }) => ({
      path,
      kind: 'collection',
      canonicalUrl: `${target.site}${path}`,
      robots: 'index,follow',
    })),
  );
  files['seo-manifest.json'] = JSON.stringify(seo);
  files['sitemap-0.xml'] = xml([...productPaths, ...pages.map(({ path }) => path)]);
  return { files, productPaths };
}
function read(t, files, productPaths = ['/products/p-abc/']) {
  const f = fixture(t, files);
  return readPublicOutput(f.directory, f.manifest.entries, target.site, productPaths);
}
function changeManifest(files, change) {
  const manifest = JSON.parse(files[categoryManifestPath]);
  change(manifest);
  files[categoryManifestPath] = JSON.stringify(manifest);
}

test('old accepted product and pre-SSG backups remain valid without a category manifest', (t) => {
  assert.equal(read(t, publicFiles()).legacy, false);
  assert.equal(read(t, { 'index.html': 'old home' }, []).legacy, true);
});
for (const count of [0, 1, 12, 13, 25])
  test(`sealed category pages bind all ${count} products and their finite links`, (t) => {
    const { files, productPaths } = categoryFiles(count);
    const output = read(t, files, productPaths);
    assert.equal(output.products.length, count);
    assert(output.discoveryPaths.includes(categoryManifestPath));
    assert.equal(hostingFilePhase({ path: categoryManifestPath }, output), 3);
    assert.equal(hostingFilePhase({ path: 'headphones/page/2/index.html' }, output), 2);
  });

test('new pagination cannot bypass checks by omitting its manifest or the product outputs', (t) => {
  const { files, productPaths } = categoryFiles();
  Reflect.deleteProperty(files, categoryManifestPath);
  assert.throws(() => read(t, files, productPaths), /requires its manifest/);
  assert.throws(
    () => read(t, { 'index.html': 'old', 'headphones/page/2/index.html': 'page' }, []),
    /requires its manifest/,
  );
});

test('category manifest rejects foreign origins, paths, purposes and unknown fields', (t) => {
  for (const change of [
    (m) => {
      m.siteOrigin = 'https://other.example';
    },
    (m) => {
      m.purpose = 'fixture';
    },
    (m) => {
      m.schemaVersion = 2;
    },
    (m) => {
      m.unknown = true;
    },
    (m) => {
      m.pages[0].family = 'foreign';
    },
    (m) => {
      m.pages[0].path = '/admin/';
    },
    (m) => {
      m.pages[1].path = '/headphones/page/02/';
    },
    (m) => {
      m.pages[0].revision = 'not-a-revision';
    },
    (m) => {
      m.pages[0].extra = 'value';
    },
  ]) {
    const { files, productPaths } = categoryFiles();
    changeManifest(files, change);
    assert.throws(() => read(t, files, productPaths), /Invalid category/);
  }
  const { files, productPaths } = categoryFiles();
  files[categoryManifestPath] = 'null';
  assert.throws(() => read(t, files, productPaths), /Invalid category manifest/);
});

test('category totals, pages and IDs cannot have gaps, duplicates or missing products', (t) => {
  for (const change of [
    (m) => {
      m.pages.splice(1, 1);
    },
    (m) => {
      m.pages.push(m.pages[0]);
    },
    (m) => {
      m.pages[1].page = 3;
      m.pages[1].path = '/headphones/page/3/';
    },
    (m) => {
      m.pages[1].total = 14;
    },
    (m) => {
      m.pages[1].revision = 'b'.repeat(64);
    },
    (m) => {
      m.pages[0].productIds.pop();
    },
    (m) => {
      m.pages[1].productIds[0] = m.pages[0].productIds[0];
    },
    (m) => {
      m.pages[1].productIds[0] = 'withdrawn';
    },
    (m) => {
      m.pages[0].productIds.reverse();
    },
    (m) => {
      m.pages.pop();
    },
  ]) {
    const { files, productPaths } = categoryFiles();
    changeManifest(files, change);
    assert.throws(() => read(t, files, productPaths), /category/i);
  }
});

test('category paths must exist in HTML, SEO and sitemap with collection identity', (t) => {
  for (const change of [
    (files) => {
      Reflect.deleteProperty(files, 'headphones/page/2/index.html');
    },
    (files) => {
      const m = JSON.parse(files['seo-manifest.json']);
      m.entries = m.entries.filter((e) => e.path !== '/headphones/page/2/');
      files['seo-manifest.json'] = JSON.stringify(m);
    },
    (files) => {
      const m = JSON.parse(files['seo-manifest.json']);
      m.entries.find((e) => e.path === '/headphones/page/2/').kind = 'utility';
      files['seo-manifest.json'] = JSON.stringify(m);
    },
    (files) => {
      const m = JSON.parse(files['seo-manifest.json']);
      m.entries.find((e) => e.path === '/headphones/page/2/').robots = 'noindex,follow';
      files['seo-manifest.json'] = JSON.stringify(m);
    },
    (files) => {
      const m = JSON.parse(files['seo-manifest.json']);
      m.entries.find((e) => e.path === '/headphones/page/2/').canonicalUrl =
        `${target.site}/headphones/`;
      files['seo-manifest.json'] = JSON.stringify(m);
    },
    (files) => {
      files['sitemap-0.xml'] = files['sitemap-0.xml'].replace(
        `<url><loc>${target.site}/headphones/page/2/</loc></url>`,
        '',
      );
    },
    (files) => {
      files['headphones/page/3/index.html'] = 'unexpected';
    },
    (files) => {
      const m = JSON.parse(files['seo-manifest.json']);
      m.entries.push({ path: '/headphones/page/3/', kind: 'collection' });
      files['seo-manifest.json'] = JSON.stringify(m);
    },
    (files) => {
      files['sitemap-0.xml'] = files['sitemap-0.xml'].replace(
        '</urlset>',
        `<url><loc>${target.site}/headphones/page/3/</loc></url></urlset>`,
      );
    },
  ]) {
    const { files, productPaths } = categoryFiles();
    change(files);
    assert.throws(() => read(t, files, productPaths), /category/i);
  }
});

test('only actual initial HTML product anchors can satisfy the category inventory', (t) => {
  const anchor = '<a data-product-card="id-000" href="/products/p-id-000/">Product id-000</a>';
  for (const replacement of [
    'Product id-000',
    `<script>const card=${JSON.stringify(anchor)}</script>`,
    `<template>${anchor}</template>`,
    `<noscript>${anchor}</noscript>`,
    `<div hidden>${anchor}</div>`,
    `<div aria-hidden="true">${anchor}</div>`,
    anchor.replace('href="/products/p-id-000/"', 'href="/products/p-id-001/"'),
    anchor.replace('href="/products/p-id-000/"', 'href="products/p-id-000/"'),
    anchor + anchor,
  ]) {
    const { files, productPaths } = categoryFiles();
    files['headphones/index.html'] = files['headphones/index.html'].replace(anchor, replacement);
    assert.throws(() => read(t, files, productPaths), /category/i);
  }
});

test('category HTML must keep its own canonical and usable adjacent links', (t) => {
  for (const change of [
    (html) =>
      html.replace(`href="${target.site}/headphones/"`, 'href="https://other.example/headphones/"'),
    (html) =>
      html.replace('</head>', `<link rel="canonical" href="${target.site}/headphones/"></head>`),
    (html) => html.replace('href="/headphones/page/2/"', 'href="/headphones/page/99/"'),
    (html) => html.replace('href="/headphones/page/2/"', 'href="/toys/"'),
    (html) =>
      html.replace('href="/headphones/page/2/"', 'href="https://other.example/headphones/page/2/"'),
    (html) => html.replace('<a href="/headphones/page/2/">Next or previous</a>', 'Next'),
  ]) {
    const { files, productPaths } = categoryFiles();
    files['headphones/index.html'] = change(files['headphones/index.html']);
    assert.throws(() => read(t, files, productPaths), /category/i);
  }
});

test('recovery to a pre-pagination version removes only owned obsolete pages and its metadata', (t) => {
  const f = fixture(t, publicFiles());
  const result = planHostingRecovery({
    ...f,
    target,
    currentOwnedPaths: [
      categoryManifestPath,
      'catalog-pages/customer-data.json',
      'headphones/page/2/index.html',
      '_astro/old.js',
    ],
    publicProductPaths: ['/products/p-abc/'],
  });
  assert.deepEqual(result.deletes, [categoryManifestPath, 'headphones/page/2/index.html']);
  const old = fixture(t, {
    [categoryManifestPath]: 'old manifest',
    'index.html': 'home',
    '_astro/old.js': 'old code',
  });
  const retained = retainSiteAssets(new Map([['index.html', Buffer.from('new')]]), {
    directory: old.directory,
    staticManifest: old.manifest,
  });
  assert(!retained.has(categoryManifestPath));
  assert(retained.has('_astro/old.js'));
});
