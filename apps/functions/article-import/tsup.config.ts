import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  clean: true,
  minify: true,
  sourcemap: false,
  noExternal: [/.*/],
  define: {
    'process.env.CHANNEL_BUILD_SHA': JSON.stringify(
      process.env.CHANNEL_BUILD_SHA || process.env.GITHUB_SHA || 'local',
    ),
  },
});
