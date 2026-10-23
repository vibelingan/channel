import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  clean: true,
  minify: true,
  sourcemap: false,
  noExternal: [
    /@vibelingan-channel\//,
    '@cloudbase/node-sdk',
    'wx-server-sdk',
    'zod',
    'ajv',
    'ajv-formats',
    'jsonc-parser',
  ],
});
