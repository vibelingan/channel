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
    if (page.kind === 'product' || page.kind === 'article') {
      const type = page.kind === 'product' ? 'Product' : 'Article';
      requireValue(
        nodes.some((node) => node['@type'] === type && node.url === expectedUrl),
        `${path}: missing ${type} schema at its canonical URL`,
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
  const sitemapFiles = outputFiles.filter((file) =>
    /^sitemap-\d+\.xml$/.test(relative(directory, file)),
  );
  requireValue(sitemapFiles.length > 0, 'missing sitemap output');
  for (const file of sitemapFiles) {
    const { ast } = await parse(await readFile(file, 'utf8'));
    sitemapUrls.push(...elements(ast, 'loc').map((node) => decode(textContent(node)).trim()));
  }
  const { ast: index } = await parse(await readFile(join(directory, 'sitemap-index.xml'), 'utf8'));
  const indexUrls = elements(index, 'loc').map((node) => decode(textContent(node)).trim());
  const expectedIndex = sitemapFiles.map((file) => `${origin}/${relative(directory, file)}`);
  requireValue(
    indexUrls.length === expectedIndex.length &&
      expectedIndex.every((url) => indexUrls.includes(url)),
    'sitemap index origin/files disagree with build',
  );
  validateManifest(entries, sitemapUrls);
  await writeFile(
    join(directory, 'seo-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, siteOrigin: origin, entries }, null, 2)}\n`,
  );
  return entries;
}
