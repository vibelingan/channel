// @ts-check
import { readFileSync } from 'node:fs';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import { parseDocument } from 'yaml';
import { serverBlogBuild } from '../../scripts/release/public-build-env.mjs';
import { readBlogBuild } from './src/lib/blog/snapshot.ts';
import { seoGate } from './src/lib/seo/integration.ts';
import { productSitemapDates } from './src/lib/seo/product-sitemap.ts';
import { decodeProductSnapshot } from './src/lib/seo/product-snapshot.ts';
import {
  includeInSitemap as includePage,
  isSitemapPathIncluded as includePath,
} from './src/lib/seo/route-policy.ts';

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
const blogServer = serverBlogBuild(env);
const productDates = env.SEO_CATALOG_SNAPSHOT
  ? productSitemapDates(
      decodeProductSnapshot(JSON.parse(readFileSync(env.SEO_CATALOG_SNAPSHOT, 'utf8')), site),
    )
  : new Map<string, string>();
const blog = blogServer ? { snapshot: null } : await readBlogBuild(site);

const catalogSource = readFileSync(
  new URL('./src/i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const frontmatter = catalogSource.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!frontmatter) throw new Error('Catalog content is missing frontmatter.');
const document = parseDocument(frontmatter[1], { uniqueKeys: true });
if (document.errors.length) throw document.errors[0];
const catalog = document.toJS() as { families?: Array<{ href?: unknown }> };
const published = new Set(
  (catalog.families ?? []).flatMap(({ href }) =>
    typeof href === 'string' && href.startsWith('/') ? [href] : [],
  ),
);

export function isSitemapPathIncluded(
  path: string,
  paths: ReadonlySet<string> = published,
): boolean {
  return includePath(path, paths);
}
export function includeInSitemap(page: string): boolean {
  if (new URL(page).pathname.replace(/\/$/, '') === '/blog' && !blog.snapshot?.articles.length)
    return false;
  return includePage(page, published);
}

export default defineConfig({
  site,
  redirects: {
    '/success-stories': '/portfolio/',
  },
  integrations: [
    react(),
    sitemap({
      serialize: (item) => {
        const date = productDates.get(item.url);
        return date ? { ...item, lastmod: date } : item;
      },
      filter: (page) =>
        blogServer && new URL(page).pathname.startsWith('/blog') ? false : includeInSitemap(page),
      ...(blogServer ? { customSitemaps: [`${site}/blog/sitemap.xml`] } : {}),
    }),
    seoGate(site, { blogServer }),
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
