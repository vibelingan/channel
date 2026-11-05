import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './release/input.mjs';
const require = createRequire(new URL('../apps/functions/admin/package.json', import.meta.url));
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
export async function buildCatalogClock(directory, codeSha = '0'.repeat(40)) {
  if (!/^[a-f0-9]{40}$/.test(codeSha)) throw Error('Exact clock source commit required');
  await mkdir(directory, { recursive: true });
  await require('tsup').build({
    define: { __CLOCK_SHA__: JSON.stringify(codeSha) },
    entry: {
      index: fileURLToPath(new URL('../tools/catalog-seo-clock/index.mjs', import.meta.url)),
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
  if (bytes.length > 8 * 1024 * 1024) throw Error('Catalog clock bundle exceeds bound');
  return { bytes: bytes.length, sha256: sha256(bytes) };
}
