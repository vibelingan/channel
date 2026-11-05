import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertIndexingResponse, projectRobotsAllows } from './index-readiness.ts';
import { inspectSitemap } from './output-gate.ts';
import { createPageDescriptor, serializePageDescriptor } from './page.ts';
const origin = 'https://example.test';
const page = createPageDescriptor({
  path: '/',
  title: 'Example',
  description: 'Public example',
  content: { source: 'fixture' },
});
const html = `<html><head><title>Example</title><meta name="description" content="Public example"><meta property="og:url" content="${origin}/"><meta property="og:title" content="Example"><meta property="og:description" content="Public example"><link rel="canonical" href="${origin}/"><script id="channel-page-descriptor" type="application/json">${serializePageDescriptor(page)}</script><script type="application/ld+json">{"@type":"WebPage","url":"${origin}/"}</script></head><body><main><h1>Example</h1><p>Actual public content.</p></main></body></html>`;
const robots = 'User-agent: *\nAllow: /\nDisallow: /api/\nAllow: /api/images/\nDisallow: /admin\n';
const check = (extra = {}) =>
  assertIndexingResponse({
    path: '/',
    origin,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html' }),
    html,
    robots,
    ...extra,
  });
test('the repository permits public product images while private API routes stay disallowed', async () => {
  const actual = await readFile(new URL('../../../public/robots.txt', import.meta.url), 'utf8');
  assert.equal(projectRobotsAllows(actual, '/api/images/public-image'), true);
  for (const path of ['/api/admin', '/api/products', '/admin/', '/login/'])
    assert.equal(projectRobotsAllows(actual, path), false, path);
});
test('actual initial HTML, self canonical and public crawl policy pass together', async () => {
  assert.equal((await check()).canonicalUrl, `${origin}/`);
});
test('a noindex or none HTTP header cannot be hidden by indexable HTML', async () => {
  for (const value of ['noindex,nofollow', 'Googlebot: noindex', 'none'])
    await assert.rejects(
      check({ headers: new Headers({ 'content-type': 'text/html', 'x-robots-tag': value }) }),
      /header/,
    );
});
test('HTTP errors, redirects, wrong content type and blocked crawl rules fail', async () => {
  for (const status of [301, 404, 503]) await assert.rejects(check({ status }), /HTTP/);
  await assert.rejects(
    check({ headers: new Headers({ 'content-type': 'application/json' }) }),
    /HTML/,
  );
  await assert.rejects(check({ robots: 'User-agent: *\nDisallow: /' }), /robots/);
});
test('missing initial body and wrong canonical fail the shared output gate', async () => {
  await assert.rejects(check({ html: html.replace('<p>Actual public content.</p>', '') }), /body/);
  await assert.rejects(
    check({ html: html.replace(`href="${origin}/"`, 'href="https://other.test/"') }),
    /canonical/,
  );
});
test('unsupported robots syntax is rejected instead of guessed as crawlable', () => {
  assert.throws(
    () => projectRobotsAllows('User-agent: Googlebot\nDisallow: /', '/'),
    /project robots/,
  );
  assert.throws(() => projectRobotsAllows('User-agent: *\nDisallow: /*?q=', '/'), /project robots/);
});

test('sitemap inspection preserves canonical URL identity and rejects ambiguous discovery', async () => {
  const xml = (value: string) =>
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${value}</loc></url></urlset>`;
  assert.deepEqual(await inspectSitemap(xml(`${origin}/`), origin), {
    kind: 'urls',
    urls: [`${origin}/`],
  });
  for (const value of [
    'https://other.test/',
    `${origin}/?search=1`,
    `${origin}/products`,
    `${origin}/#section`,
  ])
    await assert.rejects(inspectSitemap(xml(value), origin), /sitemap/);
  await assert.rejects(inspectSitemap('<urlset></urlset><urlset></urlset>', origin), /sitemap/);
  await assert.rejects(inspectSitemap('<!DOCTYPE urlset><urlset></urlset>', origin), /sitemap/);
  await assert.rejects(inspectSitemap('<sitemapindex></sitemapindex>', origin), /sitemap/);
  await assert.rejects(
    inspectSitemap(
      `<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/</loc></url></urlset>`,
      origin,
    ),
    /duplicate/,
  );
});

test('the read-only audit discovers maps, checks actual headers and makes its sample size explicit', async () => {
  const { auditIndexReadiness } = await import('../../../scripts/check-index-readiness.ts');
  const calls: string[] = [];
  const request = async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === '/api/products')
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: Buffer.from(
          JSON.stringify({ ok: true, data: { items: [], page: 1, pageSize: 48, total: 0 } }),
        ),
      };
    if (path === '/robots.txt')
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: Buffer.from(robots),
      };
    if (path === '/sitemap-index.xml')
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/xml' }),
        body: Buffer.from(
          `<sitemapindex><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
        ),
      };
    if (path === '/sitemap-0.xml')
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/xml' }),
        body: Buffer.from(
          `<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/blog/</loc></url></urlset>`,
        ),
      };
    return {
      status: 200,
      headers: new Headers({
        'content-type': 'text/html',
        ...(path === '/blog/' ? { 'x-robots-tag': 'noindex,nofollow' } : {}),
      }),
      body: Buffer.from(html),
    };
  };
  const report = await auditIndexReadiness(origin, { request });
  assert.equal(report.ready, false);
  assert.equal(report.allPagesChecked, true);
  assert.equal(report.discoveredPages, 2);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].message, /header/);
  assert.equal(report.meaning, 'technical-readiness-only; search-engine-indexing-is-not-proven');
  assert(calls.every((url) => new URL(url).origin === origin));
});

test('a newly public product missing from the sitemap is reported without fetching its private data', async () => {
  const { auditIndexReadiness } = await import('../../../scripts/check-index-readiness.ts');
  const request = async (url: string) => {
    const path = new URL(url).pathname;
    const body =
      path === '/robots.txt'
        ? robots
        : path === '/api/products'
          ? JSON.stringify({
              ok: true,
              data: {
                items: [{ _id: 'missing', name: 'Public fixture' }],
                total: 1,
                page: 1,
                pageSize: 48,
              },
            })
          : path === '/sitemap-index.xml'
            ? `<urlset><url><loc>${origin}/</loc></url></urlset>`
            : html;
    return {
      status: 200,
      headers: new Headers({
        'content-type': path.endsWith('.xml')
          ? 'application/xml'
          : path === '/api/products'
            ? 'application/json'
            : path.endsWith('.txt')
              ? 'text/plain'
              : 'text/html',
      }),
      body: Buffer.from(body),
    };
  };
  const report = await auditIndexReadiness(origin, { request });
  assert.equal(report.ready, false);
  assert.equal(report.publicProductPages, 1);
  assert.deepEqual(report.missingProducts, [`${origin}/products/p-missing/`]);
});
