import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchFully } from '../../../../scripts/smoke-http.mjs';
const root = 'https://supplychainsai.com';
if (!process.argv[2]) throw Error('Usage: node reproduce-public-http.mjs <new-output-directory>');
const out = resolve(process.argv[2]);
let exists = false;
try {
  await access(`${out}/public-audit.json`);
  exists = true;
} catch {}
if (exists) throw Error('Refusing to overwrite existing audit evidence');
await mkdir(out, { recursive: true });
const observations = [];
async function read(path) {
  const u = new URL(path, root);
  if (u.origin !== root) throw Error('Only this public website is allowed');
  const start = Date.now();
  try {
    const r = await fetchFully('GET', u.href, {
      timeoutMs: 25000,
      maxBytes: 4 * 1024 * 1024,
      redirect: 'manual',
      headers: { 'cache-control': 'no-cache' },
    });
    const html = r.body.toString('utf8');
    const tags = html.match(/<(?:meta|link|img|a)\b[^>]*>/gi) ?? [];
    const attr = (t) =>
      Object.fromEntries(
        [...t.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map((m) => [
          m[1].toLowerCase(),
          m[3].replaceAll('&amp;', '&'),
        ]),
      );
    const parsed = tags.map((t) => ({
      tag: t.slice(1, t.search(/[\s>]/)).toLowerCase(),
      ...attr(t),
    }));
    const graphs = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter((m) => /application\/ld\+json/.test(m[1]))
      .map((m) => {
        try {
          return JSON.parse(m[2]);
        } catch {
          return { parseError: true };
        }
      });
    const row = {
      url: u.href,
      status: r.status,
      location: r.headers.get('location'),
      elapsedMs: Date.now() - start,
      bytes: r.body.length,
      sha256: createHash('sha256').update(r.body).digest('hex'),
      contentType: r.headers.get('content-type'),
      robotsHeader: r.headers.get('x-robots-tag'),
      robots: parsed
        .filter((t) => ['robots', 'googlebot', 'bingbot'].includes(t.name?.toLowerCase()))
        .map((t) => t.content),
      canonical: parsed.filter((t) => t.rel === 'canonical').map((t) => t.href),
      title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
      description: parsed.find((t) => t.name === 'description')?.content,
      lang: html.match(/<html[^>]*\blang=["']([^"']+)/i)?.[1],
      h1: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
        m[1].replace(/<[^>]*>/g, '').trim(),
      ),
      graphs,
      images: parsed
        .filter((t) => t.tag === 'img')
        .map(({ src, alt, width, height, loading }) => ({ src, alt, width, height, loading })),
      links: parsed.filter((t) => t.tag === 'a' && t.href).map((t) => t.href),
      videos: html.match(/<video\b[^>]*>/gi) ?? [],
    };
    observations.push(row);
    return html;
  } catch (e) {
    observations.push({ url: u.href, error: String(e.message) });
    return '';
  }
}
const robots = await read('/robots.txt');
await writeFile(`${out}/robots.txt`, robots);
const index = await read('/sitemap-index.xml');
const maps = [...index.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
const entries = [];
for (const map of maps) {
  const xml = await read(map);
  entries.push(...[...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]));
}
const blogXml = await read('/blog/sitemap.xml');
const blogs = [...blogXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
const manifest = JSON.parse(await read('/products/manifest.json'));
const products = entries.filter((u) => u.includes('/products/p-'));
const paths = [
  '/',
  '/headphones/',
  '/ai-gadgets/',
  '/electronics-toys/',
  '/misc/',
  '/oem/',
  '/toys/',
  '/cases/',
  '/blog/',
  '/headphones/?category=headphones-bluetooth&page=1',
  '/headphones/?page=1',
  ...blogs,
  ...[products[0], products[Math.floor(products.length / 2)], products.at(-1)],
].filter(Boolean);
for (let n = 0; n < paths.length; n += 3) await Promise.all(paths.slice(n, n + 3).map(read));
await writeFile(
  `${out}/public-audit.json`,
  `${JSON.stringify({ observedAt: new Date().toISOString(), scope: 'initial HTTP HTML, not rendered browser or Google index', writes: 0, sitemap: { maps, entries, blogs, unique: new Set(entries).size, manifestCount: manifest.total ?? manifest.products?.length }, observations }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      sitemapEntries: entries.length,
      blogEntries: blogs.length,
      observations: observations.map((x) => ({
        url: x.url,
        status: x.status,
        location: x.location,
        title: x.title,
        canonical: x.canonical,
        robots: x.robots,
        error: x.error,
      })),
    },
    null,
    2,
  ),
);
