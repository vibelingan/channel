import { defineConfig } from 'tsup';

const releaseId = process.env.CHANNEL_BUILD_SHA || process.env.GITHUB_SHA || 'local';
const buildTime = process.env.CHANNEL_BUILD_TIME || new Date().toISOString();

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  define: {
    'process.env.CHANNEL_BUILD_SHA': JSON.stringify(releaseId),
    'process.env.CHANNEL_BUILD_TIME': JSON.stringify(buildTime),
  },
  noExternal: [
    '@vibelingan-channel/shared',
    '@vibelingan-channel/db',
    '@vibelingan-channel/media-storage',
    '@cloudbase/node-sdk',
    'wx-server-sdk',
    'zod',
  ],
});
