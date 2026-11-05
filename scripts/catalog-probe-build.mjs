import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/functions/admin/package.json', import.meta.url));
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
export async function buildCatalogProbe(directory) {
  await mkdir(directory, { recursive: true });
  const { build } = require('tsup');
  await build({
    entry: {
      index: fileURLToPath(
        new URL('../packages/db/src/catalog-seo-live-probe.ts', import.meta.url),
      ),
    },
    outDir: directory,
    format: ['cjs'],
    outExtension: () => ({ js: '.js' }),
    target: 'node20',
    platform: 'node',
    bundle: true,
    minify: true,
    sourcemap: false,
    clean: true,
    config: false,
    silent: true,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.alias = { '@cloudbase/node-sdk': dbRequire.resolve('@cloudbase/node-sdk') };
    },
  });
  await writeFile(
    resolve(directory, 'package.json'),
    JSON.stringify({ private: true, main: 'index.js' }),
    { flag: 'wx' },
  );
  const bytes = await readFile(resolve(directory, 'index.js'));
  if (bytes.length > 8 * 1024 * 1024)
    throw Error('Isolated probe bundle exceeds the reviewed budget');
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
