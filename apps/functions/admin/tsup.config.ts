import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  target: 'node18',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // wx-server-sdk is provided by the CloudBase runtime; keep it external.
  external: ['wx-server-sdk'],
  noExternal: ['@vibelingan-channel/shared', '@vibelingan-channel/auth', '@vibelingan-channel/db'],
});
