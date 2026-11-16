import sax from 'sax';
import { limits, productPath } from './input.mjs';

export const categoryManifestPath = 'catalog-pages/manifest.json';
const families = ['headphones', 'ai-gadgets', 'toys', 'misc'];
const pageSize = 12;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
const pagePath = (family, page) => `/${family}/${page === 1 ? '' : `page/${page}/`}`;
export const isCategoryPageFile = (path) =>
  families.some((family) => path.startsWith(`${family}/page/`) && path.endsWith('.html'));
export const isCategoryPagePath = (path) =>
  typeof path === 'string' && families.some((family) => path.startsWith(`/${family}/page/`));

/** Check category discovery against the same sealed product files used for recovery. */
export function validateCategoryOutput({ manifest, paths, read, origin, products, seo, sitemap }) {
  if (manifest === undefined) {
    if (
      [...paths].some(isCategoryPageFile) ||
      seo.some((entry) => isCategoryPagePath(entry.path)) ||
      sitemap.some(isCategoryPagePath)
    )
      throw Error('Category pagination requires its manifest');
    return;
  }
  if (
    !record(manifest) ||
    Object.keys(manifest).sort().join(',') !== 'pages,purpose,schemaVersion,siteOrigin' ||
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== 'public' ||
    manifest.siteOrigin !== origin ||
    !Array.isArray(manifest.pages) ||
    manifest.pages.length < families.length ||
    manifest.pages.length > limits.urls
  )
    throw Error('Invalid category manifest');
  const productPaths = new Set(products);
  const seoPaths = new Map(seo.map((entry) => [entry.path, entry]));
  const sitemapPaths = new Set(sitemap);
  const seenProducts = new Set();
  const seenPaths = new Set();
  const groups = new Map(families.map((family) => [family, []]));
  for (const row of manifest.pages) {
    if (
      !record(row) ||
      Object.keys(row).sort().join(',') !== 'family,page,path,productIds,revision,total' ||
      !groups.has(row.family) ||
      !Number.isSafeInteger(row.page) ||
      row.page < 1 ||
      !Number.isSafeInteger(row.total) ||
      row.total < 0 ||
      row.total > limits.urls ||
      row.path !== pagePath(row.family, row.page) ||
      typeof row.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.revision) ||
      !Array.isArray(row.productIds) ||
      row.productIds.length > pageSize ||
      seenPaths.has(row.path)
    )
      throw Error('Invalid category page identity, total or revision');
    seenPaths.add(row.path);
    for (const id of row.productIds) {
      const path = `/products/p-${id}/`;
      if (typeof id !== 'string' || !idPattern.test(id) || !productPaths.has(path))
        throw Error('Category page references a missing or withdrawn product');
      if (seenProducts.has(id)) throw Error('Duplicate category product');
      seenProducts.add(id);
    }
    const seoPage = seoPaths.get(row.path);
    if (
      seoPage?.kind !== 'collection' ||
      seoPage.robots !== 'index,follow' ||
      seoPage.canonicalUrl !== `${origin}${row.path}` ||
      !sitemapPaths.has(row.path)
    )
      throw Error('Category page is missing from SEO manifest or sitemap');
    const file = `${row.path.slice(1)}index.html`;
    if (!paths.has(file)) throw Error('Missing category HTML');
    groups.get(row.family).push(row);
  }
  for (const [family, rows] of groups) {
    rows.sort((a, b) => a.page - b.page);
    const first = rows[0];
    if (!first || rows.length !== Math.max(1, Math.ceil(first.total / pageSize)))
      throw Error('Category page count does not match its total');
    const ids = rows.flatMap((row) => row.productIds);
    if (ids.some((id, index) => index > 0 && ids[index - 1] >= id))
      throw Error('Category products are not in stable ID order');
    const expected = new Set(rows.map((item) => item.path));
    for (const [index, row] of rows.entries()) {
      if (
        row.page !== index + 1 ||
        row.total !== first.total ||
        row.revision !== first.revision ||
        row.productIds.length !== Math.min(pageSize, Math.max(0, row.total - index * pageSize))
      )
        throw Error('Category pagination has gaps or inconsistent totals');
      const html = new TextDecoder('utf-8', { fatal: true }).decode(
        read(`${row.path.slice(1)}index.html`, limits.fileBytes),
      );
      const links = categoryLinks(html, origin, row.path);
      if (JSON.stringify(links.products) !== JSON.stringify(row.productIds))
        throw Error('Category HTML product links disagree with its manifest');
      if (
        [...links.pages].some((path) => !expected.has(path)) ||
        (row.page > 1 && !links.pages.has(pagePath(family, row.page - 1))) ||
        (row.page < rows.length && !links.pages.has(pagePath(family, row.page + 1)))
      )
        throw Error('Category HTML pagination links disagree with its manifest');
    }
  }
  for (const path of paths)
    if (isCategoryPageFile(path) && !seenPaths.has(`/${path.slice(0, -10)}`))
      throw Error('Category HTML is absent from its manifest');
  for (const path of [...seoPaths.keys(), ...sitemapPaths])
    if (isCategoryPagePath(path) && !seenPaths.has(path))
      throw Error('Category discovery has an unlisted pagination path');
}

function categoryLinks(html, origin, path) {
  const parser = sax.parser(false, { lowercase: true, strictEntities: true });
  const stack = [];
  const products = [];
  const pages = new Set();
  const canonicals = [];
  const voidTags = new Set(
    'area base br col embed hr img input link meta param source track wbr'.split(' '),
  );
  parser.onopentag = (node) => {
    const attrs = node.attributes;
    const parent = stack.at(-1);
    const ignored =
      parent?.ignored ||
      ['script', 'template', 'noscript'].includes(node.name) ||
      Object.hasOwn(attrs, 'hidden') ||
      attrs['aria-hidden'] === 'true' ||
      Object.hasOwn(attrs, 'inert');
    const inMain = node.name === 'main' || parent?.inMain;
    const pagination =
      parent?.pagination || (node.name === 'nav' && attrs['aria-label'] === 'Pagination');
    if (node.name === 'link' && attrs.rel?.split(/\s+/).includes('canonical'))
      canonicals.push(attrs.href);
    if (!ignored && inMain && node.name === 'a') {
      if (Object.hasOwn(attrs, 'data-product-card')) {
        const id = attrs['data-product-card'];
        if (!idPattern.test(id) || canonicalLink(attrs.href, origin) !== `/products/p-${id}/`)
          throw Error('Invalid category HTML product link');
        products.push(id);
      } else if (productPath.test(canonicalLink(attrs.href, origin, false) ?? '')) {
        throw Error('Category HTML has an unlisted product link');
      }
      if (pagination) pages.add(canonicalLink(attrs.href, origin));
    }
    if (!node.isSelfClosing && !voidTags.has(node.name))
      stack.push({ name: node.name, ignored, inMain, pagination });
  };
  parser.onclosetag = (name) => {
    const index = stack.findLastIndex((entry) => entry.name === name);
    if (index >= 0) stack.length = index;
  };
  parser.write(html).close();
  if (canonicals.length !== 1 || canonicalLink(canonicals[0], origin) !== path)
    throw Error('Category HTML canonical disagrees with its manifest');
  return { products, pages };
}

function canonicalLink(href, origin, required = true) {
  try {
    if (typeof href !== 'string' || /[%\\\s]/u.test(href)) throw Error();
    const url = new URL(href, origin);
    if (
      url.origin !== origin ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      (href.startsWith('/') ? href.startsWith('//') || href !== url.pathname : href !== url.href)
    )
      throw Error();
    return url.pathname;
  } catch {
    if (required) throw Error('Noncanonical category HTML link');
    return null;
  }
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
