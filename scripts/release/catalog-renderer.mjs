import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256 } from './input.mjs';

export const RENDERER_RUNTIME = Object.freeze({ node: '22.13.0', pnpm: '11.5.0' });
const sourcePaths = [
  'apps/site',
  'packages',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'biome.json',
];
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const commit = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);

/** Read Git objects, never local credentials, modified files or node_modules. */
export function packCatalogRenderer({
  codeSha,
  directory,
  git = (args) => execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024 }),
}) {
  if (!commit(codeSha)) throw Error('Exact renderer commit required');
  const found = git(['rev-parse', `${codeSha}^{commit}`])
    .toString()
    .trim();
  if (found !== codeSha) throw Error('Renderer commit differs');
  const entries = git(['ls-tree', '-rz', codeSha, '--', ...sourcePaths])
    .toString()
    .split('\0')
    .filter(Boolean);
  if (!entries.length || entries.length > 20000) throw Error('Renderer file count exceeds bound');
  for (const entry of entries) {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
    if (
      !match ||
      /(?:^|\/)(?:\.env(?:\..*)?|node_modules|dist|\.git)(?:\/|$)|[\r\n\\]/.test(match[2])
    )
      throw Error('Unsafe renderer source member');
  }
  const lock = git(['show', `${codeSha}:pnpm-lock.yaml`]);
  const pkg = JSON.parse(git(['show', `${codeSha}:package.json`]).toString());
  if (pkg.packageManager !== `pnpm@${RENDERER_RUNTIME.pnpm}`)
    throw Error('Renderer package manager differs from its runtime recipe');
  const archive = gzipSync(git(['archive', '--format=tar', codeSha, '--', ...sourcePaths]), {
    level: 6,
  });
  if (archive.length > 128 * 1024 * 1024) throw Error('Renderer archive exceeds bound');
  const manifest = {
    schemaVersion: 1,
    purpose: 'catalog-renderer',
    repository: 'vibelingan/channel',
    codeSha,
    inputSchema: 1,
    runtime: RENDERER_RUNTIME,
    sourcePaths,
    archive: { name: 'renderer.tar.gz', bytes: archive.length, sha256: sha256(archive) },
    lockSha256: sha256(lock),
    files: entries.length,
  };
  mkdirSync(directory, { recursive: false });
  writeFileSync(join(directory, 'renderer.tar.gz'), archive, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'renderer.json'), JSON.stringify(manifest), {
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}

export function verifyCatalogRenderer({ manifest, approved, archive }) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== 'catalog-renderer' ||
    manifest.repository !== 'vibelingan/channel' ||
    !commit(manifest.codeSha) ||
    manifest.inputSchema !== 1 ||
    JSON.stringify(manifest.runtime) !== JSON.stringify(RENDERER_RUNTIME) ||
    !hash(manifest.lockSha256) ||
    !Number.isInteger(manifest.files) ||
    manifest.files < 1 ||
    manifest.files > 20000 ||
    JSON.stringify(manifest.sourcePaths) !== JSON.stringify(sourcePaths)
  )
    throw Error('Unsupported renderer program');
  if (
    !approved ||
    approved.codeSha !== manifest.codeSha ||
    approved.manifestSha256 !== sha256(JSON.stringify(manifest)) ||
    approved.archiveSha256 !== manifest.archive?.sha256 ||
    typeof approved.archiveObject?.fileID !== 'string' ||
    !approved.archiveObject.fileID.startsWith('cloud://')
  )
    throw Error('Renderer has no matching approved archive');
  if (
    !Buffer.isBuffer(archive) ||
    manifest.archive?.name !== 'renderer.tar.gz' ||
    archive.length !== manifest.archive.bytes ||
    archive.length > 128 * 1024 * 1024 ||
    sha256(archive) !== manifest.archive.sha256
  )
    throw Error('Renderer archive is damaged');
  return Object.freeze({
    codeSha: manifest.codeSha,
    manifestSha256: approved.manifestSha256,
    archiveSha256: approved.archiveSha256,
    archiveFileId: approved.archiveObject.fileID,
    inputSchema: 1,
  });
}

/** The approved package is unpacked by a bounded extractor before any program runs. */
export function unpackCatalogRenderer({ manifest, approved, archiveFile, directory }) {
  if (process.versions.node !== RENDERER_RUNTIME.node)
    throw Error('Renderer Node runtime differs from approved recipe');
  const proof = verifyCatalogRenderer({ manifest, approved, archive: readFileSync(archiveFile) });
  execFileSync(
    'python3',
    [new URL('./extract-renderer.py', import.meta.url).pathname, archiveFile, directory],
    { stdio: 'pipe' },
  );
  if (sha256(readFileSync(join(directory, 'pnpm-lock.yaml'))) !== manifest.lockSha256)
    throw Error('Renderer lockfile differs');
  return proof;
}
