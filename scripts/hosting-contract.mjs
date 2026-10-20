import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchFully } from './smoke-http.mjs';

export const WEBSITE_DOCUMENTS = { indexDocument: 'index.html', errorDocument: '404.html' };
const digest = (body) => createHash('sha256').update(body).digest('hex');
const routes = [
  { path: '/', file: 'index.html', status: 200 },
  { path: '/headphones/', file: 'headphones/index.html', status: 200 },
  { path: '/__channel_seo_missing__/', file: '404.html', status: 404 },
  { path: '/products/__channel_seo_missing__/', file: '404.html', status: 404 },
];

export function assertMutableCachePolicy(value) {
  const directives = value
    .toLowerCase()
    .split(',')
    .map((item) => item.trim());
  if (directives.includes('no-store')) return;
  if (
    directives.some(
      (item) =>
        /^(stale-if-error|stale-while-revalidate)\s*=/.test(item) &&
        !/^(stale-if-error|stale-while-revalidate)\s*=\s*"?0"?$/.test(item),
    )
  )
    throw new Error('Mutable HTML must not opt into serving stale content.');
  if (directives.includes('no-cache')) return;
  const ages = directives.filter((item) => /^(s-maxage|max-age)\s*=/.test(item));
  if (
    !directives.includes('must-revalidate') ||
    !ages.some((item) => /^max-age\s*=\s*"?0"?$/.test(item)) ||
    ages.some((item) => !/^(s-maxage|max-age)\s*=\s*"?0"?$/.test(item))
  )
    throw new Error(
      `Mutable HTML can be reused without validation: ${value || '(missing Cache-Control)'}`,
    );
}

function assertErrorDocument(body) {
  const html = body.toString('utf8');
  const robots = (html.match(/<meta\b[^>]*>/gi) ?? []).find((tag) =>
    /\bname\s*=\s*["']robots["']/i.test(tag),
  );
  if (
    !/<main\b[^>]*\bdata-not-found-page(?:[=\s>])/i.test(html) ||
    !robots ||
    !/\bcontent\s*=\s*["'][^"']*\bnoindex\b/i.test(robots)
  )
    throw new Error(
      'Missing the dedicated noindex error document; homepage fallback is not accepted.',
    );
}

/** Validate required output before any cloud mutation and pin ordinary GETs to these bytes. */
export function hostingContractHashes(dist) {
  assertErrorDocument(readFileSync(join(dist, WEBSITE_DOCUMENTS.errorDocument)));
  const manifest = JSON.parse(readFileSync(join(dist, 'products/manifest.json'), 'utf8'));
  const product = manifest.products?.[0]?.path;
  if (product !== undefined && !/^\/products\/p-[A-Za-z0-9_-]{1,200}\/$/.test(product))
    throw new Error('Invalid public product probe path.');
  const releaseFiles = [
    ...routes,
    { path: '/sitemap-index.xml', file: 'sitemap-index.xml' },
    ...readdirSync(dist)
      .filter((file) => /^sitemap-\d+\.xml$/.test(file))
      .map((file) => ({ path: `/${file}`, file })),
    { path: '/products/manifest.json', file: 'products/manifest.json' },
    { path: '/seo-manifest.json', file: 'seo-manifest.json' },
    ...(product ? [{ path: product, file: `${product.slice(1)}index.html` }] : []),
  ];
  return Object.fromEntries(
    releaseFiles.map((route) => [route.path, digest(readFileSync(join(dist, route.file)))]),
  );
}

/** Read only. Normal URLs intentionally have no cache-busting query. */
export async function auditHostingContract(
  site,
  { request = fetchFully, expectedHashes = {}, cacheOnly = false } = {},
) {
  const origin = new URL(site);
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Hosting audit requires an HTTP(S) origin without credentials, path or query.');
  const additional = Object.keys(expectedHashes)
    .filter((path) => !routes.some((route) => route.path === path))
    .map((path) => {
      if (
        !/^\/(?:sitemap-(?:index|\d+)\.xml|products\/manifest\.json|seo-manifest\.json|products\/p-[A-Za-z0-9_-]{1,200}\/)$/u.test(
          path,
        )
      )
        throw new Error('Invalid release probe path.');
      return { path, status: 200 };
    });
  const checks = [];
  for (const route of [...routes, ...additional]) {
    let ordinaryHash;
    for (const revalidate of [false, true]) {
      const check = {
        path: route.path,
        mode: revalidate ? 'revalidate' : 'ordinary',
        passed: false,
      };
      try {
        const response = await request('GET', new URL(route.path, origin).href, {
          timeoutMs: 15000,
          maxBytes: 2 * 1024 * 1024,
          ...(revalidate ? { headers: { 'cache-control': 'no-cache' } } : {}),
        });
        const hash = digest(response.body);
        Object.assign(check, {
          status: response.status,
          cacheControl: response.headers.get('cache-control') ?? '',
          etag: response.headers.get('etag'),
          bytes: response.body.length,
          sha256: hash,
        });
        if (!revalidate) ordinaryHash = hash;
        if (response.status !== route.status)
          throw new Error(`Expected HTTP ${route.status}, got ${response.status}.`);
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const acceptedMime = route.path.endsWith('.xml')
          ? ['application/xml', 'text/xml']
          : route.path.endsWith('.json')
            ? ['application/json']
            : ['text/html'];
        if (!acceptedMime.includes(mime)) throw new Error('Unexpected response content type.');
        if (!cacheOnly && route.status === 404) assertErrorDocument(response.body);
        assertMutableCachePolicy(check.cacheControl);
        if (expectedHashes[route.path] && expectedHashes[route.path] !== hash)
          throw new Error('Ordinary URL differs from the accepted release artifact.');
        if (revalidate && ordinaryHash && ordinaryHash !== hash)
          throw new Error('Ordinary and revalidated URLs return different bytes.');
        check.passed = true;
      } catch (error) {
        check.error = error instanceof Error ? error.message : 'Hosting request failed.';
      }
      checks.push(check);
    }
  }
  return {
    site: origin.origin,
    scope: cacheOnly ? 'cache-preflight' : 'release',
    observedAt: new Date().toISOString(),
    passed: checks.every((check) => check.passed),
    checks,
  };
}
