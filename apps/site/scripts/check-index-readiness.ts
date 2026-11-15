import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchFully } from '../../../scripts/smoke-http.mjs';
import { assertIndexingResponse, projectRobotsAllows } from '../src/lib/seo/index-readiness.ts';
import { inspectSitemap } from '../src/lib/seo/output-gate.ts';
import { indexPolicy, siteOrigin } from '../src/lib/seo/page.ts';
import { collectPublicProductPaths } from '../src/lib/seo/product-snapshot.ts';

type Read = (url: string) => Promise<{ status: number; headers: Headers; body: Buffer }>;
const read: Read = (url) =>
  fetchFully('GET', url, {
    timeoutMs: 15000,
    maxBytes: 2 * 1024 * 1024,
    redirect: 'error',
    headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' },
  });

export async function auditIndexReadiness(
  originInput: string,
  options: { allProducts?: boolean; request?: Read } = {},
) {
  const origin = siteOrigin(originInput);
  const request = options.request ?? read;
  const problems: { url: string; message: string }[] = [];
  const get = async (path: string) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash)
      throw Error('Only this site may be inspected');
    return request(url.href);
  };
  const robotsResponse = await get('/robots.txt');
  if (
    robotsResponse.status !== 200 ||
    !/^text\/plain(?:;|$)/i.test(robotsResponse.headers.get('content-type') ?? '')
  )
    throw Error('The actual robots.txt could not be read');
  const robots = robotsResponse.body.toString('utf8');
  const imageCrawlAllowed = projectRobotsAllows(robots, '/api/images/seo-crawl-check');
  if (!imageCrawlAllowed)
    problems.push({ url: `${origin}/robots.txt`, message: 'Public product images are disallowed' });
  const maps: { url: string; urls: number }[] = [];
  const pages = new Set<string>();
  const visited = new Set<string>();
  async function sitemap(url: string, depth: number) {
    if (depth > 1 || visited.has(url) || visited.size >= 20)
      throw Error('Invalid or excessive sitemap traversal');
    visited.add(url);
    const response = await get(url);
    if (
      response.status !== 200 ||
      !/^(?:application|text)\/xml(?:;|$)/i.test(response.headers.get('content-type') ?? '')
    )
      throw Error('A sitemap did not return XML with HTTP 200');
    const parsed = await inspectSitemap(response.body.toString('utf8'), origin);
    maps.push({ url, urls: parsed.urls.length });
    if (parsed.kind === 'index') {
      if (depth !== 0) throw Error('Nested sitemap indexes are not supported');
      for (const next of parsed.urls) await sitemap(next, depth + 1);
    } else
      for (const page of parsed.urls) {
        if (pages.has(page) || pages.size >= 50000)
          throw Error('Duplicate or excessive public sitemap URLs');
        pages.add(page);
        const path = new URL(page).pathname;
        if (indexPolicy(path) !== 'index,follow' || !projectRobotsAllows(robots, path))
          problems.push({
            url: page,
            message: 'A private or crawl-blocked page is in the sitemap',
          });
      }
  }
  await sitemap(`${origin}/sitemap-index.xml`, 0);
  if (!pages.size) throw Error('No public pages were discovered');
  const products = [...pages]
    .filter((url) => new URL(url).pathname.startsWith('/products/p-'))
    .sort();
  const sample =
    options.allProducts || products.length <= 12
      ? products
      : Array.from(
          { length: 12 },
          (_, i) => products[Math.floor((i * (products.length - 1)) / 11)],
        );
  const publicProductPaths = await collectPublicProductPaths(origin, async (input) => {
    const response = await request(String(input));
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers,
    });
  });
  const expectedProducts = new Set(publicProductPaths.map((path) => new URL(path, origin).href));
  const productSet = new Set(products);
  const missingProducts = [...expectedProducts].filter((url) => !productSet.has(url));
  const retiredProducts = products.filter((url) => !expectedProducts.has(url));
  for (const url of missingProducts)
    problems.push({ url, message: 'A current public product is missing from the sitemap' });
  for (const url of retiredProducts)
    problems.push({ url, message: 'A withdrawn product remains in the sitemap' });

  const selected = [...new Set([...pages].filter((url) => !productSet.has(url)).concat(sample))];
  const checked: {
    url: string;
    ready: boolean;
    kind?: string;
    revision?: string;
    message?: string;
  }[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, selected.length) }, async () => {
      while (cursor < selected.length) {
        const url = selected[cursor++];
        try {
          const response = await get(url);
          const page = await assertIndexingResponse({
            path: new URL(url).pathname,
            origin,
            status: response.status,
            headers: response.headers,
            html: response.body.toString('utf8'),
            robots,
          });
          checked.push({ url, ready: true, kind: page.kind, revision: page.content.revision });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Page inspection failed';
          checked.push({ url, ready: false, message });
          problems.push({ url, message });
        }
      }
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    siteOrigin: origin,
    ready: problems.length === 0,
    meaning: 'technical-readiness-only; search-engine-indexing-is-not-proven',
    allPagesChecked: selected.length === pages.size,
    discoveredPages: pages.size,
    productPages: products.length,
    publicProductPages: expectedProducts.size,
    missingProducts,
    retiredProducts,
    checkedProductPages: sample.length,
    imageCrawlAllowed,
    sitemaps: maps,
    checked: checked.sort((a, b) => a.url.localeCompare(b.url)),
    problems: problems.sort((a, b) => a.url.localeCompare(b.url)),
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [origin, destination, mode] = process.argv.slice(2);
  if (!origin || !destination || (mode !== undefined && mode !== '--all-products'))
    throw Error(
      'Usage: tsx apps/site/scripts/check-index-readiness.ts <site-origin> <report.json> [--all-products]',
    );
  const report = await auditIndexReadiness(origin, { allProducts: mode === '--all-products' });
  await mkdir(dirname(resolve(destination)), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(
    JSON.stringify({
      ready: report.ready,
      discoveredPages: report.discoveredPages,
      checkedPages: report.checked.length,
      allPagesChecked: report.allPagesChecked,
      problems: report.problems.length,
    }),
  );
  if (!report.ready) process.exitCode = 1;
}
