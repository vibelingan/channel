import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertMutableCachePolicy, auditHostingContract } from './hosting-contract.mjs';

const html = Buffer.from(
  '<html><head><meta name="robots" content="noindex,follow"></head><main data-not-found-page><h1>Page not found</h1></main></html>',
);
const response = (status, body, cache = 'no-cache') => ({
  status,
  body: Buffer.from(body),
  headers: new Headers({ 'content-type': 'text/html', 'cache-control': cache }),
});
const request = async (_method, url) =>
  url.includes('__channel_seo_missing__')
    ? response(404, html)
    : response(200, '<main>Current page</main>');

test('mutable HTML must revalidate and cannot retain a positive shared cache TTL', () => {
  for (const policy of ['no-cache', 'no-store', 'public, max-age=0, must-revalidate'])
    assert.doesNotThrow(() => assertMutableCachePolicy(policy));
  for (const policy of [
    '',
    'public, max-age=300, s-maxage=600',
    'max-age=0, s-maxage=600, must-revalidate',
    'max-age=0',
    'no-cache, stale-if-error=60',
    'no-cache, stale-if-error="060"',
    'no-cache, stale-while-revalidate=001',
  ])
    assert.throws(() => assertMutableCachePolicy(policy), undefined, policy);
});

test('cache preflight accepts an old error body only when status and cache policy are safe', async () => {
  const oldSite = async (_method, url) =>
    response(url.includes('__channel_seo_missing__') ? 404 : 200, '<main>Homepage</main>');
  const before = await auditHostingContract('https://example.com', {
    request: oldSite,
    cacheOnly: true,
  });
  assert.equal(before.scope, 'cache-preflight');
  assert.equal(before.passed, true);
  assert.equal(
    (await auditHostingContract('https://example.com', { request: oldSite })).passed,
    false,
  );
  assert.equal(
    (
      await auditHostingContract('https://example.com', {
        cacheOnly: true,
        request: async (_method, url) =>
          response(url.includes('__channel_seo_missing__') ? 404 : 200, html, 'max-age=300'),
      })
    ).passed,
    false,
  );
});

test('audit uses ordinary URLs and also checks revalidated bytes without a cache-busting query', async () => {
  const calls = [];
  const report = await auditHostingContract('https://example.com', {
    request: async (...args) => {
      calls.push(args);
      return request(...args);
    },
  });
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 8);
  assert.ok(
    calls.every(
      ([, url, options]) => !new URL(url).search && options.maxBytes > 0 && options.timeoutMs > 0,
    ),
  );
  assert.equal(
    calls.filter(([, , options]) => options.headers?.['cache-control'] === 'no-cache').length,
    4,
  );
});

test('audit rejects homepage-as-error, soft 404, stale cache and mismatching representations', async () => {
  for (const mutate of [
    (res, missing) => (missing ? response(404, '<main>Homepage</main>') : res),
    (res, missing) => (missing ? response(200, html) : res),
    () => response(200, 'stale', 'public, max-age=300, s-maxage=600'),
    (res, _missing, revalidate) => (revalidate ? { ...res, body: Buffer.from('different') } : res),
  ]) {
    const report = await auditHostingContract('https://example.com', {
      request: async (method, url, options) =>
        mutate(
          await request(method, url),
          url.includes('__channel_seo_missing__'),
          !!options.headers,
        ),
    });
    assert.equal(report.passed, false);
    assert.ok(report.checks.some((check) => !check.passed));
  }
});

test('transport failure is reported and cannot skip the remaining routes', async () => {
  let calls = 0;
  const report = await auditHostingContract('https://example.com', {
    request: async () => {
      calls++;
      throw new Error('deadline reached');
    },
  });
  assert.equal(calls, 8);
  assert.equal(report.passed, false);
  assert.ok(report.checks.every((check) => !check.passed && check.error === 'deadline reached'));
  await assert.rejects(auditHostingContract('https://user:password@example.com'));
});

test('matching ordinary/revalidated stale bytes still fail against the accepted artifact', async () => {
  const report = await auditHostingContract('https://example.com', {
    request,
    expectedHashes: { '/': 'different-release-hash' },
  });
  assert.equal(report.passed, false);
  assert.ok(
    report.checks
      .filter((check) => check.path === '/')
      .every((check) => /accepted release/.test(check.error)),
  );
});

test('release probes include product canonical URLs and discovery files with their actual MIME', async () => {
  const expected = {
    '/products/p-demo/': '<h1>Current product</h1>',
    '/sitemap-index.xml': '<sitemapindex/>',
    '/sitemap-0.xml': '<urlset/>',
    '/products/manifest.json': '{"products":[]}',
    '/seo-manifest.json': '{"entries":[]}',
  };
  const expectedHashes = Object.fromEntries(
    Object.entries(expected).map(([path, body]) => [
      path,
      createHash('sha256').update(body).digest('hex'),
    ]),
  );
  const report = await auditHostingContract('https://example.com', {
    expectedHashes,
    request: async (method, url, options) => {
      const path = new URL(url).pathname;
      if (!(path in expected)) return request(method, url, options);
      const res = response(200, expected[path]);
      res.headers.set(
        'content-type',
        path.endsWith('.json')
          ? 'application/json'
          : path.endsWith('.xml')
            ? 'text/xml'
            : 'text/html',
      );
      return res;
    },
  });
  assert.equal(report.checks.length, 18);
  assert.equal(report.passed, true);
  await assert.rejects(
    auditHostingContract('https://example.com', {
      expectedHashes: { 'https://another.example/': 'hash' },
    }),
    /probe path/,
  );
});
