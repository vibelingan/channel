import { readFileSync } from 'node:fs';
// @ts-check
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import { parseDocument } from 'yaml';

const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');

// Proxy /api -> local-server (or remote) to avoid CORS during dev.
// Enabled by default; set PUBLIC_CB_PROXY=0 to disable.
const cbProxy = env.PUBLIC_CB_PROXY !== '0';
const cbHost = env.PUBLIC_CB_HOST || 'localhost:3002';
// Canonical origin for sitemap/canonical/schema comes from build-time SITE_URL
// (deploy sets vars.SITE_URL=https://supplychainsai.com). The localhost fallback
// is a deliberate, test-pinned contract (portfolio-content.test.ts): no
// production domain is baked into build config — non-deploy builds stay visibly
// local instead of silently stamping production canonicals.
const siteUrl = env.SITE_URL?.trim() || 'http://localhost:4321';
const site = new URL(siteUrl).href.replace(/\/$/, '');

// Pages that must stay out of the sitemap (auth, admin, form results, redirects).
// Private routes are mirrored by robots.txt; crawlable noindex routes use page metadata only.
const NOINDEX_PATHS = new Set([
  '/admin',
  '/login',
  '/register',
  '/account',
  '/reset',
  '/oem_submit_result',
  '/products/item',
  '/success-stories',
]);

const catalogSource = readFileSync(
  new URL('./src/i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const catalogFrontmatter = catalogSource.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!catalogFrontmatter) throw new Error('Catalog content is missing frontmatter.');
const catalogDocument = parseDocument(catalogFrontmatter[1], { uniqueKeys: true });
if (catalogDocument.errors.length > 0) throw catalogDocument.errors[0];
const catalogFamilies = catalogDocument.toJS() as { families?: Array<{ href?: unknown }> };
const PUBLISHED_CATALOG_PATHS = new Set(
  (catalogFamilies.families ?? [])
    .map((family) => family.href)
    .filter((href): href is string => typeof href === 'string' && href.startsWith('/'))
    .map((href) => href.replace(/\/$/, '')),
);
const ALL_CATALOG_PATHS = new Set(['/headphones', '/ai-gadgets', '/toys', '/misc']);

export function isSitemapPathIncluded(
  path: string,
  publishedCatalogPaths: ReadonlySet<string> = PUBLISHED_CATALOG_PATHS,
): boolean {
  if (NOINDEX_PATHS.has(path)) return false;
  return !ALL_CATALOG_PATHS.has(path) || publishedCatalogPaths.has(path);
}

export function includeInSitemap(page: string): boolean {
  return isSitemapPathIncluded(new URL(page).pathname.replace(/\/$/, ''));
}

export default defineConfig({
  site,
  redirects: {
    '/success-stories': '/portfolio',
  },
  integrations: [
    react(),
    sitemap({
      filter: includeInSitemap,
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    server: cbProxy
      ? {
          proxy: {
            // Forward admin API calls to the local-server (or remote) to avoid CORS.
            '/api': {
              target: `http://${cbHost}`,
              changeOrigin: true,
            },
          },
        }
      : undefined,
  },
});
