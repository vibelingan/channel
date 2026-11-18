import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import { factoryVideoAsset, publicWatchVideo } from './src/lib/seo/video-record.ts';

const outDir = './dist-blog/';

const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');
export default defineConfig({
  site: env.SITE_URL || 'http://localhost:4321',
  base: '/blog',
  trailingSlash: 'ignore',
  srcDir: './src/blog-server',
  publicDir: './blog-public',
  outDir,
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    react(),
    {
      name: 'channel-public-factory-video',
      hooks: {
        'astro:build:done': async () => {
          if (!publicWatchVideo('factory-overview')) return;
          const source = new URL(`./public${factoryVideoAsset.source}`, import.meta.url);
          const bytes = await readFile(source);
          if (
            bytes.length !== factoryVideoAsset.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== factoryVideoAsset.sha256
          )
            throw Error('The approved factory video does not match its asset record');
          const destination = new URL(
            `${outDir}client/${factoryVideoAsset.clientPath}`,
            import.meta.url,
          );
          await mkdir(new URL('./', destination), { recursive: true });
          await writeFile(destination, bytes, { flag: 'wx' });
        },
      },
    },
  ],
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
