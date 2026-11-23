// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { type Plugin, loadEnv, normalizePath } from 'vite';
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
import { withVideoSitemapMetadata } from './src/lib/seo/video-record.ts';

// Keep shared validation together. Leave detail transports and admin collection
// definitions outside the chunk used by the header and account menu.
const storefrontValidationFiles = new Set(
  [
    './src/lib/api-url.ts',
    '../../packages/shared/src/catalog-product.ts',
    '../../packages/shared/src/catalog-taxonomy.ts',
    '../../packages/shared/src/media.ts',
    '../../packages/shared/src/manual-catalog-pricing.ts',
    '../../packages/shared/src/catalog/alibaba-pricing-adapter.ts',
    '../../packages/shared/src/catalog/resolve-pricing.ts',
  ].map((path) => normalizePath(fileURLToPath(new URL(path, import.meta.url)))),
);
const storefrontValidationChunk: Plugin = {
  name: 'channel-storefront-validation-chunk',
  apply: 'build',
  configEnvironment(name) {
    if (name !== 'client') return;
    return {
      build: {
        rollupOptions: {
          output: {
            onlyExplicitManualChunks: true,
            manualChunks(id) {
              const file = normalizePath(id);
              if (storefrontValidationFiles.has(file) || file.includes('/node_modules/zod/v3/'))
                return 'storefront-validation';
            },
          },
        },
      },
    };
  },
};

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
  // `dev:assistant-site` turns the dev toolbar off: on a phone-sized window it
  // covers the assistant launcher, which no production page has.
  devToolbar: { enabled: env.ASTRO_DEV_TOOLBAR !== '0' },
  redirects: {
    '/success-stories': '/portfolio/',
  },
  integrations: [
    react(),
    sitemap({
      serialize: (item) => {
        const date = productDates.get(item.url);
        return withVideoSitemapMetadata(date ? { ...item, lastmod: date } : item, site, blogServer);
      },
      filter: (page) =>
        blogServer && new URL(page).pathname.startsWith('/blog') ? false : includeInSitemap(page),
      ...(blogServer ? { customSitemaps: [`${site}/blog/sitemap.xml`] } : {}),
    }),
    seoGate(site, { blogServer }),
  ],
  vite: {
    plugins: [tailwindcss(), storefrontValidationChunk],
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
