import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse } from '@astrojs/compiler';
import type { ElementNode, Node as HtmlNode } from '@astrojs/compiler/types';
import {
  type PageDescriptor,
  canonicalPath,
  canonicalUrl,
  createPageDescriptor,
  siteOrigin,
} from './page.ts';

export interface ManifestEntry {
  path: string;
  canonicalUrl: string;
  kind: PageDescriptor['kind'];
  robots: PageDescriptor['robots'];
  title: string;
  description: string;
  content: PageDescriptor['content'];
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SEO gate: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSchemaType(node: Record<string, unknown>, type: string): boolean {
  return node['@type'] === type || (Array.isArray(node['@type']) && node['@type'].includes(type));
}

function priceAmount(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)))
    return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function validCurrency(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function validOffer(value: unknown): boolean {
  if (!record(value)) return false;
  if (hasSchemaType(value, 'AggregateOffer')) {
    const low = priceAmount(value.lowPrice);
    const high = value.highPrice === undefined ? low : priceAmount(value.highPrice);
    return low !== null && high !== null && high >= low && validCurrency(value.priceCurrency);
  }
  if (!hasSchemaType(value, 'Offer')) return false;
  const price = Object.hasOwn(value, 'price')
    ? value
    : record(value.priceSpecification) &&
        (hasSchemaType(value.priceSpecification, 'PriceSpecification') ||
          hasSchemaType(value.priceSpecification, 'UnitPriceSpecification'))
      ? value.priceSpecification
      : null;
  return price !== null && priceAmount(price.price) !== null && validCurrency(price.priceCurrency);
}

function validRating(value: unknown): boolean {
  if (!record(value)) return false;
  const rating = priceAmount(value.ratingValue);
  const worst = priceAmount(value.worstRating ?? 1);
  const best = priceAmount(value.bestRating ?? 5);
  return (
    rating !== null &&
    worst !== null &&
    best !== null &&
    best > worst &&
    rating >= worst &&
    rating <= best
  );
}

function validProduct(node: Record<string, unknown>, url: string): boolean {
  if (node.url !== url || typeof node.name !== 'string' || !node.name.trim()) return false;
  const offers =
    node.offers === undefined ? [] : Array.isArray(node.offers) ? node.offers : [node.offers];
  if (node.offers !== undefined && offers.length === 0) return false;
  if (offers.some((offer) => !validOffer(offer))) return false;
  const rating = node.aggregateRating;
  const ratingCount = record(rating) ? (rating.ratingCount ?? rating.reviewCount) : undefined;
  const hasRating =
    record(rating) &&
    hasSchemaType(rating, 'AggregateRating') &&
    validRating(rating) &&
    typeof ratingCount === 'number' &&
    Number.isSafeInteger(ratingCount) &&
    ratingCount > 0;
  const reviews =
    node.review === undefined ? [] : Array.isArray(node.review) ? node.review : [node.review];
  const hasReviews =
    reviews.length > 0 &&
    reviews.every(
      (review) =>
        record(review) &&
        hasSchemaType(review, 'Review') &&
        record(review.reviewRating) &&
        hasSchemaType(review.reviewRating, 'Rating') &&
        validRating(review.reviewRating) &&
        record(review.author) &&
        typeof review.author.name === 'string' &&
        review.author.name.trim(),
    );
  if ((rating !== undefined && !hasRating) || (node.review !== undefined && !hasReviews))
    return false;
  return offers.length > 0 || hasRating || hasReviews;
}

function descriptor(value: unknown, path: string): PageDescriptor {
  requireValue(record(value), `${path}: missing page descriptor`);
  requireValue(
    ['marketing', 'collection', 'product', 'article', 'utility'].includes(String(value.kind)),
    `${path}: invalid page kind`,
  );
  requireValue(
    ['index,follow', 'noindex,follow', 'noindex,nofollow'].includes(String(value.robots)),
    `${path}: invalid index policy`,
  );
  requireValue(
    typeof value.canonicalPath === 'string' &&
      typeof value.title === 'string' &&
      typeof value.description === 'string',
    `${path}: invalid metadata`,
  );
  requireValue(
    record(value.content) && typeof value.content.source === 'string',
    `${path}: missing public source`,
  );
  const { revision, updatedAt } = value.content;
  requireValue(revision === undefined || typeof revision === 'string', `${path}: invalid revision`);
  requireValue(
    updatedAt === undefined || typeof updatedAt === 'string',
    `${path}: invalid updatedAt`,
  );
  requireValue(
    Array.isArray(value.schemaNodes) && value.schemaNodes.every(record),
    `${path}: invalid schema nodes`,
  );
  return createPageDescriptor({
    path,
    kind: value.kind as PageDescriptor['kind'],
    canonicalPath: value.canonicalPath,
    robots: value.robots as PageDescriptor['robots'],
    title: value.title,
    description: value.description,
    content: { source: value.content.source, revision, updatedAt },
    schemaNodes: value.schemaNodes,
  });
}

function decode(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity: string) => {
      if (entity.startsWith('#')) {
        const point =
          entity[1].toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
      }
      return entities[entity.toLowerCase()] ?? match;
    },
  );
}

function attr(node: ElementNode, name: string): string | undefined {
  const value = node.attributes.find((attribute) => attribute.name.toLowerCase() === name);
  return value ? decode(value.value) : undefined;
}

function elements(root: HtmlNode, name: string): ElementNode[] {
  const found: ElementNode[] = [];
  function visit(node: HtmlNode) {
    if (node.type === 'element' && node.name.toLowerCase() === name) found.push(node);
    if ('children' in node) for (const child of node.children) visit(child);
  }
  visit(root);
  return found;
}

function textContent(node: HtmlNode, visible = false, skipHeading = false): string {
  if (
    visible &&
    node.type === 'element' &&
    (['script', 'style', 'template', 'nav', 'header', 'footer'].includes(node.name.toLowerCase()) ||
      (skipHeading && node.name === 'h1') ||
      attr(node, 'hidden') !== undefined ||
      attr(node, 'aria-hidden') === 'true')
  )
    return '';
  if (node.type === 'text') return node.value;
  return 'children' in node
    ? node.children.map((child) => textContent(child, visible, skipHeading)).join(' ')
    : '';
}

function meta(root: HtmlNode, key: string): string | undefined {
  const matches = elements(root, 'meta').filter(
    (node) =>
      attr(node, 'name')?.toLowerCase() === key || attr(node, 'property')?.toLowerCase() === key,
  );
  requireValue(matches.length <= 1, `duplicate ${key}`);
  return matches[0] ? attr(matches[0], 'content') : undefined;
}

function schemaNodes(root: HtmlNode): Record<string, unknown>[] {
  return elements(root, 'script')
    .filter((node) => attr(node, 'type') === 'application/ld+json')
    .flatMap((node) => {
      const parsed: unknown = JSON.parse(textContent(node));
      requireValue(record(parsed), 'invalid JSON-LD root');
      const nodes = parsed['@graph'] ?? [parsed];
      requireValue(Array.isArray(nodes) && nodes.every(record), 'invalid JSON-LD graph');
      return nodes;
    });
}

export async function inspectPage(
  html: string,
  path: string,
  origin: string,
): Promise<ManifestEntry> {
  const { ast } = await parse(html);
  const scripts = elements(ast, 'script').filter(
    (node) => attr(node, 'id') === 'channel-page-descriptor',
  );
  requireValue(scripts.length === 1, `${path}: expected one page descriptor`);
  const page = descriptor(JSON.parse(textContent(scripts[0])), path);
  const expectedUrl = canonicalUrl(page.canonicalPath, origin);
  const canonicals = elements(ast, 'link').filter(
    (node) => attr(node, 'rel')?.toLowerCase() === 'canonical',
  );
  requireValue(
    canonicals.length === 1 && attr(canonicals[0], 'href') === expectedUrl,
    `${path}: missing, duplicate or wrong canonical`,
  );
  const titles = elements(ast, 'title');
  requireValue(
    titles.length === 1 && decode(textContent(titles[0])).trim() === page.title,
    `${path}: title disagrees with descriptor`,
  );
  requireValue(
    meta(ast, 'description') === page.description,
    `${path}: description disagrees with descriptor`,
  );
  const robots = (meta(ast, 'robots') ?? 'index,follow').toLowerCase().replaceAll(' ', '');
  requireValue(robots === page.robots, `${path}: robots disagrees with descriptor`);

  if (page.robots === 'index,follow') {
    requireValue(
      canonicalPath(path) === page.canonicalPath,
      `${path}: indexable page must use its own canonical identity`,
    );
    requireValue(
      meta(ast, 'og:url') === expectedUrl &&
        meta(ast, 'og:title') === page.title &&
        meta(ast, 'og:description') === page.description,
      `${path}: social metadata disagrees with descriptor`,
    );
    const mains = elements(ast, 'main');
    requireValue(mains.length === 1, `${path}: expected one main content region`);
    const headings = elements(mains[0], 'h1');
    requireValue(
      headings.length === 1 && textContent(headings[0], true).trim(),
      `${path}: initial HTML needs one visible H1`,
    );
    requireValue(
      textContent(mains[0], true, true).trim(),
      `${path}: initial HTML has no public body outside its H1`,
    );
    const nodes = schemaNodes(ast);
    requireValue(
      nodes.some((node) => node['@type'] === 'WebPage' && node.url === expectedUrl),
      `${path}: WebPage URL disagrees with canonical`,
    );
    for (const node of nodes.filter((node) => hasSchemaType(node, 'Product')))
      requireValue(
        validProduct(node, expectedUrl),
        `${path}: invalid Product rich-result fields or canonical URL`,
      );
    if (page.kind === 'product' || page.kind === 'article') {
      if (page.kind === 'article')
        requireValue(
          nodes.some((node) => node['@type'] === 'Article' && node.url === expectedUrl),
          `${path}: missing Article schema at its canonical URL`,
        );
      const breadcrumb = nodes.find((node) => node['@type'] === 'BreadcrumbList');
      const items = breadcrumb?.itemListElement;
      requireValue(Array.isArray(items) && items.length > 0, `${path}: missing BreadcrumbList`);
      const last: unknown = items.at(-1);
      requireValue(
        record(last) &&
          (last.item === expectedUrl || (record(last.item) && last.item['@id'] === expectedUrl)),
        `${path}: breadcrumb identity disagrees with canonical`,
      );
    }
  }
  return {
    path: canonicalPath(path),
    canonicalUrl: expectedUrl,
    kind: page.kind,
    robots: page.robots,
    title: page.title,
    description: page.description,
    content: page.content,
  };
}

export function validateManifest(
  entries: readonly ManifestEntry[],
  sitemapUrls: readonly string[],
): void {
  const indexable = entries.filter((entry) => entry.robots === 'index,follow');
  const expected = indexable.map((entry) => entry.canonicalUrl);
  requireValue(
    new Set(entries.map((entry) => entry.path)).size === entries.length,
    'duplicate output paths',
  );
  for (const key of ['canonicalUrl', 'title', 'description'] as const) {
    requireValue(
      new Set(indexable.map((entry) => entry[key])).size === indexable.length,
      `duplicate public ${key}`,
    );
  }
  requireValue(new Set(sitemapUrls).size === sitemapUrls.length, 'duplicate sitemap URL');
  requireValue(
    expected.length === sitemapUrls.length && expected.every((url) => sitemapUrls.includes(url)),
    'sitemap must exactly match indexable HTML (missing, extra or private URL)',
  );
}

/** Read the site's XML discovery documents with the same parser used by the build gate. */
export async function inspectSitemap(xml: string, originInput: string) {
  const origin = siteOrigin(originInput);
  requireValue(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'sitemap declarations are unsupported');
  const { ast } = await parse(xml);
  const indexes = elements(ast, 'sitemapindex');
  const sets = elements(ast, 'urlset');
  requireValue(indexes.length + sets.length === 1, 'expected one sitemap root');
  const kind = indexes.length ? 'index' : 'urls';
  requireValue(
    xml.includes(kind === 'index' ? '</sitemapindex>' : '</urlset>'),
    'unclosed sitemap root',
  );
  const root = indexes[0] ?? sets[0];
  const rows = elements(root, kind === 'index' ? 'sitemap' : 'url');
  requireValue(kind !== 'index' || rows.length > 0, 'empty sitemap index');
  requireValue(rows.length <= 50000, 'sitemap exceeds the URL limit');
  const lastModified = new Map<string, string>();
  const urls = rows.map((row) => {
    const loc = elements(row, 'loc');
    requireValue(loc.length === 1, 'sitemap entry needs one location');
    const value = decode(textContent(loc[0])).trim();
    const url = new URL(value);
    requireValue(
      url.origin === origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.href === canonicalUrl(url.pathname, origin),
      'sitemap contains a foreign or noncanonical URL',
    );
    const dates = elements(row, 'lastmod');
    requireValue(
      dates.length <= 1 && dates.every((date) => row.children.includes(date)),
      `invalid sitemap lastmod: ${url.href}`,
    );
    if (dates[0]) lastModified.set(url.href, decode(textContent(dates[0])).trim());
    return url.href;
  });
  requireValue(new Set(urls).size === urls.length, 'duplicate sitemap URL');
  requireValue(elements(root, 'loc').length === urls.length, 'unexpected sitemap locations');
  return { kind, urls, lastModified };
}

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)],
    ),
  );
  return groups.flat().sort();
}

const verificationFiles: Record<string, string> = {
  'googlefc43809ad650355b.html': 'google-site-verification: googlefc43809ad650355b.html',
  'BingSiteAuth.xml':
    '<?xml version="1.0"?>\n<users>\n\t<user>9AB098EF372986D7D22F0ADFD2328AAC</user>\n</users>',
};

export async function validateSiteOutput(
  directory: string,
  originInput: string,
  options: { blogServer?: boolean } = {},
): Promise<ManifestEntry[]> {
  const origin = siteOrigin(originInput);
  const outputFiles = await files(directory);
  for (const [name, expected] of Object.entries(verificationFiles)) {
    requireValue(
      (await readFile(join(directory, name), 'utf8')) === expected,
      `verification file missing/changed: ${name}`,
    );
  }
  const entries: ManifestEntry[] = [];
  for (const file of outputFiles.filter((file) => file.endsWith('.html'))) {
    const filename = relative(directory, file).split(sep).join('/');
    if (filename in verificationFiles) continue;
    const path =
      filename === 'index.html'
        ? '/'
        : filename.endsWith('/index.html')
          ? `/${filename.slice(0, -10)}`
          : `/${filename.slice(0, -5)}/`;
    const html = await readFile(file, 'utf8');
    if (path === '/success-stories/') {
      const { ast } = await parse(html);
      const canonical = elements(ast, 'link').find((node) => attr(node, 'rel') === 'canonical');
      requireValue(
        canonical && attr(canonical, 'href') === `${origin}/portfolio/`,
        'legacy redirect points at wrong canonical',
      );
      requireValue(
        elements(ast, 'meta').some(
          (node) =>
            attr(node, 'http-equiv')?.toLowerCase() === 'refresh' &&
            attr(node, 'content') === '0;url=/portfolio/',
        ),
        'legacy redirect is missing or points at the wrong destination',
      );
      continue;
    }
    entries.push(await inspectPage(html, path, origin));
  }
  requireValue(entries.length > 0, 'no HTML pages were inspected');
  const sitemapUrls: string[] = [];
  const lastModified = new Map<string, string>();
  const sitemapFiles = outputFiles.filter((file) =>
    /^sitemap-\d+\.xml$/.test(relative(directory, file)),
  );
  requireValue(sitemapFiles.length > 0, 'missing sitemap output');
  for (const file of sitemapFiles) {
    const sitemap = await inspectSitemap(await readFile(file, 'utf8'), origin);
    requireValue(sitemap.kind === 'urls', 'static sitemap fragment must contain page URLs');
    sitemapUrls.push(...sitemap.urls);
    for (const [url, date] of sitemap.lastModified) lastModified.set(url, date);
  }
  const { ast: index } = await parse(await readFile(join(directory, 'sitemap-index.xml'), 'utf8'));
  const indexUrls = elements(index, 'loc').map((node) => decode(textContent(node)).trim());
  validateSitemapIndex(
    indexUrls,
    sitemapFiles.map((file) => relative(directory, file)),
    origin,
    options.blogServer,
  );
  validateManifest(entries, sitemapUrls);
  for (const entry of entries) {
    if (entry.kind !== 'product' || entry.robots !== 'index,follow') continue;
    requireValue(
      lastModified.get(entry.canonicalUrl) === entry.content.updatedAt,
      `${entry.path}: sitemap lastmod disagrees with the public content date`,
    );
  }
  await writeFile(
    join(directory, 'seo-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, siteOrigin: origin, entries }, null, 2)}\n`,
  );
  return entries;
}

export function validateSitemapIndex(
  actual: string[],
  staticFiles: string[],
  originInput: string,
  blogServer = false,
) {
  const origin = siteOrigin(originInput);
  const expected = staticFiles.map((file) => `${origin}/${file}`);
  if (blogServer) expected.push(`${origin}/blog/sitemap.xml`);
  requireValue(
    new Set(actual).size === actual.length &&
      actual.length === expected.length &&
      expected.every((url) => actual.includes(url)),
    'sitemap index origin/files disagree with build',
  );
}
