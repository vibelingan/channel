import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  noExternal: ['@vibelingan-channel/ai-contracts', '@vibelingan-channel/ai-store'],
});
