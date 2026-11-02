import base from './tsup.config';
import { defineConfig } from 'tsup';

export default defineConfig({
  ...base,
  entry: { index: 'src/cloud-acceptance.ts' },
  outDir: 'dist/acceptance',
});
