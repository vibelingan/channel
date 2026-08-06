// @ts-check
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');

// Proxy /api -> local-server (or remote) to avoid CORS during dev.
// Enabled by default; set PUBLIC_CB_PROXY=0 to disable.
const cbProxy = env.PUBLIC_CB_PROXY !== '0';
const cbHost = env.PUBLIC_CB_HOST || 'localhost:3002';
// Canonical origin for sitemap/canonical/schema. Deploy sets SITE_URL explicitly
// (GitHub env var = https://supplychainsai.com); the fallback must be the
// production domain, never localhost — a build without env would otherwise
// emit unusable sitemap URLs.
const siteUrl = env.SITE_URL?.trim() || 'https://supplychainsai.com';
const site = new URL(siteUrl).href.replace(/\/$/, '');

// Pages that must stay out of the sitemap (auth, admin, form results, redirects).
// Mirrored by robots.txt Disallow rules and per-page noindex meta.
const NOINDEX_PATHS = new Set([
  '/admin',
  '/login',
  '/register',
  '/account',
  '/reset',
  '/oem_submit_result',
  '/success-stories',
]);

export default defineConfig({
  site,
  redirects: {
    '/success-stories': '/portfolio',
  },
  integrations: [
    react(),
    sitemap({
      filter: (page) => !NOINDEX_PATHS.has(new URL(page).pathname.replace(/\/$/, '')),
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
