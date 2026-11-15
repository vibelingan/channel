import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  smokeCatalogImageDecoder,
  verifyCatalogImageDecoderArtifact,
} from '../catalog-image-decoder-artifact.mjs';
export const nativeFunctionZipLimit = 15 * 1024 * 1024;
/** A fixed Linux decoder closure, never arbitrary dependencies or an expanded default recovery policy. */
export function checkNativeFunctionArchive(input, { smoke = false } = {}) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > nativeFunctionZipLimit)
    throw Error('Native catalog ZIP exceeds its explicit scope');
  const temporary = mkdtempSync(join(tmpdir(), 'catalog-native-archive-'));
  const directory = join(temporary, 'package');
  const archive = join(temporary, 'original.zip');
  try {
    mkdirSync(directory);
    writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
    const result = spawnSync(
      'python3',
      [
        fileURLToPath(new URL('./check-native-function-zip.py', import.meta.url)),
        archive,
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 256 * 1024 },
    );
    if (result.status !== 0) {
      let diagnostic;
      try {
        diagnostic = JSON.parse(result.stderr.toString());
      } catch {
        diagnostic = null;
      }
      throw Object.assign(new Error('Native catalog ZIP validation did not complete'), {
        code:
          result.status === 1 && diagnostic?.code === 'NATIVE_ARCHIVE_INVALID'
            ? 'NATIVE_ARCHIVE_INVALID'
            : 'NATIVE_ARCHIVE_UNCONFIRMED',
        check: 'zip-structure',
        childStatus: result.status,
        childSignal: result.signal,
        childError: result.error?.code,
      });
    }
    let manifest = null;
    try {
      manifest = verifyCatalogImageDecoderArtifact(directory);
    } catch {
      throw Object.assign(new Error('Native decoder closure differs from its pinned manifest'), {
        code: 'NATIVE_ARCHIVE_INVALID',
        check: 'decoder-closure',
      });
    }

    if (manifest.target !== 'linux-x64')
      throw Error('Catalog function requires the approved Linux decoder target');
    if (smoke) {
      const boot = spawnSync(
        process.execPath,
        ['-e', "if(typeof require('./index.js').main!=='function')process.exit(1)"],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            TCB_ENV: 'artifact-smoke-env',
            JWT_SECRET: 'artifact-smoke-secret',
            BOOTSTRAP_ENABLED: '0',
          },
          timeout: 15000,
          maxBuffer: 65536,
        },
      );
      if (boot.status !== 0) throw Error('Native function cold-start failed');
      smokeCatalogImageDecoder(directory);
    }
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
