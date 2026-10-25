import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dummyMain } from '../release-drill/record.mjs';
import { checkFunctionArchive } from './function-archive.mjs';
import { sha256 } from './input.mjs';

export const dummyRecoveryScope = Object.freeze({
  functionName: 'seo-release-dummy',
  hostingPrefix: '__release-canary/dummy/',
  recordPrefix: 'seo-drill-',
  collectionName: 'seoReleaseDrillFixtures',
  purpose: 'channel-recovery-dummy-v1',
});

export function buildDummyFunction({ version, codeSha }) {
  if (!['A', 'B'].includes(version) || !/^[a-f0-9]{40}$/.test(codeSha))
    throw new Error('Explicit dummy version and code SHA required');
  const configuration = { purpose: dummyRecoveryScope.purpose, version, codeSha };
  const source = `const configuration = ${JSON.stringify(configuration)};\nexports.main = (event) => (${dummyMain.toString()})(event, configuration);\n`;
  return execFileSync(
    'python3',
    [
      '-c',
      [
        'import io,json,sys,zipfile',
        'files=json.load(sys.stdin); out=io.BytesIO()',
        'with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:',
        ' for name,body in files.items():',
        '  info=zipfile.ZipInfo(name,(2026,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o100644 << 16; z.writestr(info,body)',
        'sys.stdout.buffer.write(out.getvalue())',
      ].join('\n'),
    ],
    {
      input: JSON.stringify({
        'index.js': source,
        'package.json': JSON.stringify({
          name: dummyRecoveryScope.functionName,
          main: 'index.js',
          dependencies: {},
        }),
      }),
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

/** Load only a verified fixture archive, in a temporary directory outside the workspace. */
export function loadDummyFunction(bytes) {
  checkFunctionArchive(bytes);
  const directory = mkdtempSync(join(tmpdir(), 'channel-dummy-function-'));
  const close = () => rmSync(directory, { recursive: true, force: true });
  try {
    execFileSync(
      'python3',
      [fileURLToPath(new URL('./check-function-zip.py', import.meta.url)), directory],
      {
        input: bytes,
        timeout: 10_000,
        maxBuffer: 65536,
      },
    );
    const loaded = createRequire(join(directory, 'loader.cjs'))('./index.js');
    if (typeof loaded.main !== 'function') throw new Error('Dummy function handler missing');
    return { main: loaded.applyRecord ?? loaded.main, close };
  } catch (error) {
    close();
    throw error;
  }
}

export function dummySuitePolicy(root) {
  const testRef = 'scripts/compatibility/recovery-dummy.test.mjs';
  const suiteSha256 = sha256(readFileSync(join(root, testRef)));
  return [
    ['reader', 'dummy A reads both data formats', ['dummy-v1', 'dummy-v2']],
    [
      'writer-preserves-unknown',
      'dummy A preserves newer fields and deleted records',
      ['dummy-v1', 'dummy-v2'],
    ],
    ['api-clients', 'dummy A serves both client contracts', ['dummy-ui-v1', 'dummy-ui-v2']],
    ['configuration', 'dummy A exposes its actual archived identity', []],
  ].map(([kind, requiredTest, covers]) => ({
    name: dummyRecoveryScope.functionName,
    kind,
    testRef,
    suiteSha256,
    requiredTests: [requiredTest],
    covers,
  }));
}
