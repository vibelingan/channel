import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Check the artifact before any cloud mutation, including function deployment. */
export function assertPublicProductBuild(dist, site) {
  const manifest = JSON.parse(readFileSync(resolve(dist, 'products/manifest.json'), 'utf8'));
  const pages = JSON.parse(readFileSync(resolve(dist, 'seo-manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== 'public' ||
    manifest.siteOrigin !== new URL(site).origin ||
    !Array.isArray(manifest.products) ||
    !Number.isSafeInteger(manifest.total) ||
    manifest.total !== manifest.products.length
  )
    throw new Error('Refusing to deploy synthetic, incomplete or wrong-origin product output.');
  const paths = manifest.products.map((item) => {
    if (
      !/^\/products\/p-[A-Za-z0-9_-]{1,200}\/$/.test(item.path) ||
      typeof item.revision !== 'string' ||
      !item.revision
    )
      throw new Error('Invalid public product output identity');
    return item.path;
  });
  const rendered = pages
    .filter((page) => page.kind === 'product')
    .map((page) => page.path)
    .sort();
  if (
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths.sort()) !== JSON.stringify(rendered)
  )
    throw new Error('Product output differs from the rendered SEO manifest');
  return manifest.total;
}
