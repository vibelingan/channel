export default {
  entry: { 'channel-blog-mcp': 'tools/hermes-blog/launch.mjs' },
  outDir: 'output/hermes-blog-bundle',
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  clean: false,
  banner: {
    js: "import { createRequire as nodeRequire } from 'node:module'; const require = nodeRequire(import.meta.url);",
  },
};
