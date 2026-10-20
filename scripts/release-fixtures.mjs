import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealHostingBackup } from './hosting-recovery.mjs';

export const target = { envId: 'fixture-env', site: 'https://fixture.example' };
export const digest = (body) => createHash('sha256').update(body).digest('hex');
export function fixture(t, files = { 'index.html': 'home', '_astro/a.hash.js': 'script' }) {
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
export const xml = (paths) =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${target.site}${path}</loc></url>`).join('')}</urlset>`;
export function publicFiles(paths = ['/products/p-abc/']) {
  return {
    'index.html': 'home',
    ...Object.fromEntries(
      paths.map((path) => [`${path.slice(1)}index.html`, '<h1>Public product</h1>']),
    ),
    'products/manifest.json': JSON.stringify({
      schemaVersion: 1,
      purpose: 'public',
      siteOrigin: target.site,
      total: paths.length,
      products: paths.map((path) => ({ path, revision: 'r1' })),
    }),
    'seo-manifest.json': JSON.stringify({
      schemaVersion: 1,
      siteOrigin: target.site,
      entries: paths.map((path) => ({ kind: 'product', path })),
    }),
    'sitemap-index.xml': `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${target.site}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    'sitemap-0.xml': xml(paths),
  };
}
