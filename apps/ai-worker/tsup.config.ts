import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/worker.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  noExternal: [
    '@vibelingan-channel/ai-engine',
    '@vibelingan-channel/ai-engine-anythingllm',
    '@vibelingan-channel/ai-policy',
    '@vibelingan-channel/ai-store',
  ],
});
