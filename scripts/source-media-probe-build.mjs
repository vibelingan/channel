import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packageCatalogImageDecoder,
  verifyCatalogImageDecoderArtifact,
} from './catalog-image-decoder-artifact.mjs';
const require = createRequire(new URL('../apps/functions/admin/package.json', import.meta.url));
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
export async function buildSourceMediaProbe(directory, target = 'linux-x64') {
  await mkdir(directory, { recursive: true });
  await require('tsup').build({
    entry: {
      index: fileURLToPath(
        new URL(
          '../apps/functions/alibaba-catalog-sync/src/testing/source-media-live-probe.ts',
          import.meta.url,
        ),
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
    external: ['#catalog-image-decoder'],
    noExternal: [/^(?!#catalog-image-decoder$).*/],
    esbuildOptions(options) {
      options.alias = { '@cloudbase/node-sdk': dbRequire.resolve('@cloudbase/node-sdk') };
    },
  });
  await writeFile(
    resolve(directory, 'package.json'),
    JSON.stringify({ private: true, main: 'index.js' }),
  );
  packageCatalogImageDecoder(directory, { target });
  verifyCatalogImageDecoderArtifact(directory);
  const bytes = await readFile(resolve(directory, 'index.js'));
  if (bytes.length > 8 * 1024 * 1024) throw Error('Source probe JS bundle exceeds bound');
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), target };
}
