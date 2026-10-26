import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');
export default defineConfig({
  site: env.SITE_URL || 'http://localhost:4321',
  base: '/blog',
  trailingSlash: 'ignore',
  srcDir: './src/blog-server',
  publicDir: './blog-public',
  outDir: './dist-blog',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    ssr: { noExternal: true },
    define: {
      'process.env.CHANNEL_BUILD_SHA': JSON.stringify(
        process.env.CHANNEL_BUILD_SHA || process.env.GITHUB_SHA || 'local',
      ),
      'process.env.CHANNEL_BUILD_TIME': JSON.stringify(
        process.env.CHANNEL_BUILD_TIME || new Date().toISOString(),
      ),
    },
  },
});
