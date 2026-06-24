import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  target: 'node18',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: ['@vibelingan-channel/shared', '@vibelingan-channel/db', 'wx-server-sdk', 'zod'],
});
