import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Every workspace package must be INLINED. They publish TypeScript from
  // `src`, so anything left external resolves to a `.ts` file at runtime and
  // the container dies with ERR_UNKNOWN_FILE_EXTENSION — a failure that no
  // amount of type-checking or unit testing reaches, because it only exists in
  // the built artifact. scripts/check-ai-runtime-bundle.mjs is what catches it.
  noExternal: [
    '@vibelingan-channel/ai-contracts',
    '@vibelingan-channel/ai-engine',
    '@vibelingan-channel/ai-store',
  ],
});
