import sax from 'sax';
import {
  assertHostingPath,
  assertOrigin,
  isSitemap,
  limits,
  productFile,
  productPath,
  readHostingObject,
} from './input.mjs';

/** Read only the sealed local files. No remote sitemap or entity resolution. */
export function readPublicOutput(directory, entries, siteOrigin, publicPaths) {
  assertOrigin(siteOrigin);
  const paths = new Set(entries.map((entry) => entry.path));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const read = (path, maxBytes) => {
    const entry = byPath.get(path);
    if (!entry) throw new Error(`Missing sealed file: ${path}`);
    return readHostingObject(directory, entry, maxBytes);
  };
  const json = (path) =>
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(path, limits.jsonBytes)));
  const html = entries
    .filter((entry) => productFile.test(entry.path))
    .map((entry) => `/${entry.path.slice(0, -10)}`);
  const { pages, files: discoveryPaths } = readSitemaps(read, paths, siteOrigin);
  const sitemapProducts = pages.filter((path) => productPath.test(path));
  const hasProducts = paths.has('products/manifest.json');
  const hasSeo = paths.has('seo-manifest.json');
  const allow = new Set(publicPaths);
  const rejectWithdrawn = (items) => {
    for (const path of items)
      if (!allow.has(path))
        throw new Error(`Recovery would resurrect a withdrawn product: ${path}`);
  };
  rejectWithdrawn([...html, ...sitemapProducts]);
  // Old sites without product output can still recover their pre-SSG backups.
  if (!hasProducts && !hasSeo && !html.length && !sitemapProducts.length)
    return { products: [], legacy: true, discoveryPaths };
  if (!hasProducts || !hasSeo) throw new Error('Missing public product/SEO manifest.');
  const products = json('products/manifest.json');
  const seo = json('seo-manifest.json');
  if (
    products?.schemaVersion !== 1 ||
    products.purpose !== 'public' ||
    products.siteOrigin !== siteOrigin ||
    !Array.isArray(products.products) ||
    products.total !== products.products.length ||
    products.total > limits.urls
  )
    throw new Error('Invalid product manifest schema, origin or total.');
  const productPaths = products.products.map((entry) => {
    if (
      !productPath.test(entry.path) ||
      typeof entry.revision !== 'string' ||
      !entry.revision.trim() ||
      entry.revision.length > 512
    )
      throw new Error('Invalid product manifest path/revision.');
    return entry.path;
  });
  if (
    seo?.schemaVersion !== 1 ||
    seo.siteOrigin !== siteOrigin ||
    !Array.isArray(seo.entries) ||
    seo.entries.length > limits.urls
  )
    throw new Error('Invalid SEO manifest schema or origin.');
  const seoPaths = seo.entries.map((entry) => {
    canonicalPath(entry.path, siteOrigin);
    if (
      typeof entry.kind !== 'string' ||
      (productPath.test(entry.path) && entry.kind !== 'product') ||
      (entry.kind === 'product' && !productPath.test(entry.path))
    )
      throw new Error('Invalid SEO product manifest kind.');
    return entry.path;
  });
  unique(seoPaths, 'SEO manifest');
  const seoProducts = seo.entries
    .filter((entry) => entry.kind === 'product')
    .map((entry) => entry.path);
  rejectWithdrawn([...productPaths, ...seoProducts]);
  for (const values of [productPaths, html, seoProducts, sitemapProducts])
    unique(values, 'product projection');
  if (
    !sameSet(productPaths, html) ||
    !sameSet(productPaths, seoProducts) ||
    !sameSet(productPaths, sitemapProducts)
  )
    throw new Error('Product projection mismatch across HTML, manifests and sitemap.');
  return {
    products: products.products.map(({ path, revision }) => ({ path, revision })),
    legacy: false,
    discoveryPaths,
  };
}

function readSitemaps(read, paths, origin) {
  const files = [...paths].filter(isSitemap);
  const queue = (path) => {
    const file = assertHostingPath(path.slice(1));
    if (!file.endsWith('.xml') || !paths.has(file))
      throw new Error(`Missing local sitemap fragment: ${file}`);
    if (!files.includes(file)) files.push(file);
    if (files.length > limits.sitemaps) throw new Error('Sitemap file count limit exceeded.');
    return file;
  };
  if (files.length > limits.sitemaps) throw new Error('Sitemap file count limit exceeded.');
  if (paths.has('robots.txt')) {
    const robots = new TextDecoder('utf-8', { fatal: true }).decode(
      read('robots.txt', limits.jsonBytes),
    );
    for (const line of robots.split(/\r?\n/)) {
      const directive = /^\s*Sitemap:\s*(.*?)\s*$/i.exec(line);
      if (directive) queue(canonicalUrl(directive[1], origin));
    }
  }
  const maps = new Map();
  const pages = [];
  const referenced = new Set();
  for (const file of files) {
    const parsed = parseSitemap(read(file, limits.xmlBytes), origin);
    if (parsed.kind === 'urlset') pages.push(...parsed.locations);
    else
      for (const path of parsed.locations) {
        const ref = queue(path);
        if (referenced.has(ref)) throw new Error(`Duplicate sitemap fragment: ${ref}`);
        referenced.add(ref);
      }
    maps.set(file, parsed);
    if (pages.length > limits.urls) throw new Error('Sitemap URL limit exceeded.');
  }
  const complete = new Set();
  const visiting = new Set();
  const visit = (file) => {
    if (visiting.has(file)) throw new Error('Sitemap index cycle.');
    if (complete.has(file)) return;
    visiting.add(file);
    if (maps.get(file).kind === 'sitemapindex')
      for (const path of maps.get(file).locations) visit(path.slice(1));
    visiting.delete(file);
    complete.add(file);
  };
  for (const file of files) visit(file);
  unique(pages, 'sitemap URL');
  return { pages, files };
}

function parseSitemap(body, origin) {
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  const ns = 'http://www.sitemaps.org/schemas/sitemap/0.9';
  const stack = [];
  const locations = [];
  let kind;
  parser.ondoctype = () => {
    throw new Error('Sitemap XML DTD is forbidden.');
  };
  parser.onerror = (error) => {
    throw new Error(`Invalid sitemap XML: ${error.message}`, { cause: error });
  };
  parser.onopentag = (node) => {
    if (!stack.length) {
      if (node.uri !== ns || !['urlset', 'sitemapindex'].includes(node.local))
        throw new Error('Invalid sitemap root namespace.');
      kind = node.local;
    }
    if (stack.length >= limits.depth) throw new Error('Sitemap XML depth limit exceeded.');
    const parent = stack.at(-1);
    if (
      stack.length === 1 &&
      (node.uri !== ns || node.local !== (kind === 'urlset' ? 'url' : 'sitemap'))
    )
      throw new Error('Invalid sitemap entry.');
    if (node.uri === ns && node.local === 'loc' && stack.length !== 2)
      throw new Error('Invalid sitemap loc position.');
    if (parent?.local === 'loc') throw new Error('Sitemap loc must contain text only.');
    stack.push({ local: node.local, uri: node.uri, text: '', locations: 0 });
  };
  const text = (value) => {
    if (stack.at(-1)?.local === 'loc') stack.at(-1).text += value;
  };
  parser.ontext = text;
  parser.oncdata = text;
  parser.onclosetag = () => {
    const node = stack.pop();
    if (node.uri === ns && node.local === 'loc') {
      if (++stack.at(-1).locations !== 1) throw new Error('Duplicate sitemap loc.');
      locations.push(canonicalUrl(node.text.trim(), origin));
      if (locations.length > limits.urls) throw new Error('Sitemap URL limit exceeded.');
    }
    if (stack.length === 1 && node.locations !== 1) throw new Error('Missing sitemap loc.');
  };
  try {
    parser.write(new TextDecoder('utf-8', { fatal: true }).decode(body)).close();
  } catch (cause) {
    throw new Error(`Invalid sitemap XML: ${cause.message}`, { cause });
  }
  if (!kind) throw new Error('Empty sitemap XML.');
  return { kind, locations };
}

function canonicalUrl(value, origin) {
  const url = new URL(value);
  if (
    url.origin !== origin ||
    url.href !== value ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    /[%\\\s]/u.test(value)
  )
    throw new Error('Invalid sitemap URL origin or canonical path.');
  canonicalPath(url.pathname, origin);
  return url.pathname;
}
function canonicalPath(path, origin) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[%?#\\\s]/u.test(path) ||
    new URL(path, origin).pathname !== path
  )
    throw new Error('Invalid manifest URL path.');
  if (path.startsWith('/products/p-') && !productPath.test(path))
    throw new Error('Noncanonical product URL path.');
  if (path !== '/') assertHostingPath(path.slice(1).replace(/\/$/, ''));
}
function unique(values, kind) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${kind}.`);
}
function sameSet(a, b) {
  const set = new Set(b);
  return a.length === b.length && a.every((value) => set.has(value));
}
