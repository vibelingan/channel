import { defineConfig } from 'tsup';
import base from './tsup.config';

export default defineConfig({
  ...base,
  entry: { index: 'src/cloud-acceptance.ts' },
  outDir: 'dist/acceptance',
});
