import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageDescriptor, serializePageDescriptor } from '../apps/site/src/lib/seo/page.ts';
import { runIndexNow, siteOrigin } from './release/indexnow.mjs';

const key = 'local-indexnow-test-key';
const item = `${siteOrigin}/products/p-example/`;
const article = `${siteOrigin}/blog/example/`;
const withdrawn = `${siteOrigin}/blog/withdrawn/`;
const before = '2026-11-26T00:00:00.000Z';
const after = '2026-11-27T00:00:00.000Z';
const start = Date.parse(after);
const halfHour = 30 * 60_000;

function sitemap(entries, root = 'urlset', entry = 'url') {
  return `<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
    .map(
      ([url, date]) =>
        `<${entry}><loc>${url}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}</${entry}>`,
    )
    .join('')}</${root}>`;
}

function html(url, date, kind) {
  const page = createPageDescriptor({
    path: new URL(url).pathname,
    title: 'Public item',
    description: 'A public description',
    kind,
    content: { source: 'fixture', revision: date, updatedAt: date },
  });
  const schema = [
    { '@type': 'WebPage', url },
    { '@type': 'BreadcrumbList', itemListElement: [{ item: url }] },
    ...(kind === 'article' ? [{ '@type': 'Article', url }] : []),
  ];
  return `<html><head><title>${page.title}</title><meta name="description" content="${page.description}"><meta property="og:title" content="${page.title}"><meta property="og:description" content="${page.description}"><meta property="og:url" content="${url}"><link rel="canonical" href="${url}"><script id="channel-page-descriptor" type="application/json">${serializePageDescriptor(page)}</script><script type="application/ld+json">${JSON.stringify({ '@graph': schema })}</script></head><body><main><h1>Public item</h1><p>Actual public content.</p></main></body></html>`;
}

function fixture() {
  let state = null;
  const posts = [];
  const maps = [[`${siteOrigin}/sitemap-0.xml`], [`${siteOrigin}/blog/sitemap.xml`]];
  const data = new Map([
    [
      `${siteOrigin}/sitemap-index.xml`,
      ['application/xml', sitemap(maps, 'sitemapindex', 'sitemap')],
    ],
    [`${siteOrigin}/sitemap-0.xml`, ['application/xml', sitemap([[item, before]])]],
    [`${siteOrigin}/blog/sitemap.xml`, ['application/xml', sitemap([[withdrawn, before]])]],
    [`${siteOrigin}/robots.txt`, ['text/plain', 'User-agent: *\nAllow: /\n']],
    [`${siteOrigin}/${key}.txt`, ['text/plain', key]],
    [item, ['text/html', html(item, after, 'product')]],
    [article, ['text/html', html(article, after, 'article')]],
    [withdrawn, ['text/html', '', 404]],
  ]);
  let postResponse = [200, {}];
  const request = async (method, url, options) => {
    if (method === 'POST') {
      assert.equal(url, 'https://api.indexnow.org/indexnow');
      posts.push(JSON.parse(options.body));
      return { status: postResponse[0], headers: new Headers(postResponse[1]) };
    }
    assert(data.has(url), `unexpected URL: ${url}`);
    const [type, body, status = 200] = data.get(url);
    return { status, headers: new Headers({ 'content-type': type }), body: Buffer.from(body) };
  };
  return {
    posts,
    data,
    update() {
      data.set(`${siteOrigin}/sitemap-0.xml`, ['application/xml', sitemap([[item, after]])]);
      data.set(`${siteOrigin}/blog/sitemap.xml`, ['application/xml', sitemap([[article, after]])]);
    },
    setPostResponse: (response) => {
      postResponse = response;
    },
    run: (now, submit = true) =>
      runIndexNow({
        state,
        save: async (value) => {
          state = structuredClone(value);
        },
        key,
        now,
        request,
        submit,
      }),
  };
}

test('only stable, publicly verified catalog and Blog changes are sent together once', async () => {
  const f = fixture();
  assert.equal((await f.run(start)).initialized, true);
  f.update();
  assert.equal((await f.run(start + 1)).pending, 3);
  assert.deepEqual((await f.run(start + halfHour, false)).submitted, []);
  assert.deepEqual(f.posts, []);
  const result = await f.run(start + halfHour + 1);
  assert.deepEqual(new Set(result.submitted), new Set([item, article, withdrawn]));
  assert.equal(f.posts[0].keyLocation, `${siteOrigin}/${key}.txt`);
  assert.equal((await f.run(start + 2 * halfHour)).pending, 0);
  assert.equal(f.posts.length, 1);
});

test('a stale product page and a withdrawal that still returns 200 are deferred', async () => {
  const f = fixture();
  await f.run(start);
  f.update();
  f.data.set(item, ['text/html', html(item, before, 'product')]);
  f.data.set(withdrawn, ['text/html', html(withdrawn, before, 'article')]);
  await f.run(start + 1);
  const result = await f.run(start + halfHour + 1);
  assert.deepEqual(result.submitted, [article]);
  assert.deepEqual(new Set(result.deferred.map(({ url }) => url)), new Set([item, withdrawn]));
});

test('an unavailable Blog sitemap cannot look like a mass withdrawal', async () => {
  const f = fixture();
  await f.run(start);
  f.data.set(`${siteOrigin}/blog/sitemap.xml`, ['text/plain', 'unavailable', 503]);
  await assert.rejects(f.run(start + halfHour), /could not read sitemap/);
  assert.deepEqual(f.posts, []);
});

test('a publish rolled back before the next notification does not submit either snapshot', async () => {
  const f = fixture();
  const original = [...f.data];
  await f.run(start);
  f.update();
  assert.equal((await f.run(start + 1)).pending, 3);
  for (const [url, response] of original) f.data.set(url, response);
  assert.equal((await f.run(start + halfHour + 1)).pending, 0);
  assert.deepEqual(f.posts, []);
});

test('a rate-limited batch is kept until retry, and 202 is counted once as accepted', async () => {
  const f = fixture();
  await f.run(start);
  f.update();
  await f.run(start + 1);
  f.setPostResponse([429, { 'retry-after': '3600' }]);
  const limited = await f.run(start + halfHour + 1);
  assert.equal(limited.indexNowStatus, 429);
  assert.equal(limited.pending, 3);
  await f.run(start + halfHour * 2);
  assert.equal(f.posts.length, 1);
  f.setPostResponse([202, {}]);
  const accepted = await f.run(start + halfHour * 3 + 1);
  assert.equal(accepted.indexNowStatus, 202);
  assert.equal(accepted.submitted.length, 3);
  await f.run(start + halfHour * 4);
  assert.equal(f.posts.length, 2);
});
