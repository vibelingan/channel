import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [
    '@vibelingan-channel/shared',
    '@vibelingan-channel/db',
    '@vibelingan-channel/media-storage',
    'wx-server-sdk',
    'zod',
  ],
});
