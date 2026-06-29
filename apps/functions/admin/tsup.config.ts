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
    '@vibelingan-channel/auth',
    '@vibelingan-channel/db',
    '@vibelingan-channel/email',
    '@vibelingan-channel/media-storage',
    'hash-wasm',
    'jose',
    'nodemailer',
    'wx-server-sdk',
    'zod',
  ],
});
