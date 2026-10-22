import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFunctionArchive } from './function-archive.mjs';
import { sha256 } from './input.mjs';

export const dummyRecoveryScope = Object.freeze({
  functionName: 'seo-release-dummy',
  hostingPrefix: '__release-canary/dummy/',
  recordPrefix: 'seo-drill-',
  collectionName: 'seoReleaseDrillFixtures',
  purpose: 'channel-recovery-dummy-v1',
});

// This handler transforms only supplied dummy records. It has no database, network or SDK dependency.
async function dummyMain(event, { purpose, version, codeSha }) {
  const { action, id, record, patch } = event ?? {};
  if (action === 'health') return { purpose, version, codeSha };
  if (typeof id !== 'string' || !/^seo-drill-[a-z0-9-]{1,64}$/.test(id))
    throw new Error('Only reserved dummy IDs are accepted');
  if (record && (record._id !== id || record.purpose !== purpose))
    throw new Error('Foreign dummy record');
  if (action === 'create') {
    if (record || typeof event.label !== 'string' || !event.label || event.label.length > 200)
      throw new Error('Invalid dummy create');
    return {
      record: {
        _id: id,
        purpose,
        label: event.label,
        revision: 1,
        deleted: false,
        ...(version === 'B' && typeof event.note === 'string' ? { note: event.note } : {}),
      },
    };
  }
  if (!record) throw new Error('Dummy record not found');
  if (action === 'read') return { record: { ...record } };
  if (action === 'delete')
    return { record: { ...record, deleted: true, revision: record.revision + 1 } };
  if (action !== 'update' || record.deleted || !patch || Array.isArray(patch))
    throw new Error('Invalid dummy update');
  const allowed = version === 'B' ? ['label', 'note'] : ['label'];
  if (
    !Object.keys(patch).length ||
    Object.keys(patch).some(
      (key) => !allowed.includes(key) || typeof patch[key] !== 'string' || patch[key].length > 200,
    )
  )
    throw new Error('Invalid dummy patch');
  return { record: { ...record, ...patch, revision: record.revision + 1 } };
}

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
    return { main: loaded.main, close };
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
