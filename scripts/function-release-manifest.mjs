import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FUNCTION_NAMES } from './cloudbase-function-manifest.mjs';

const commit = /^[a-f0-9]{40}$/;

/**
 * What each function must report after this deploy. A function whose code was proven
 * unchanged keeps the build that is running, so its releaseId stays that earlier commit;
 * every function's deployedReleaseId is this deploy.
 */
export function functionReleaseManifest(deployedReleaseId, functions) {
  if (!commit.test(deployedReleaseId)) throw new Error('Exact deployed commit required');
  const names = Object.keys(functions);
  if (names.some((name) => !FUNCTION_NAMES.includes(name)))
    throw new Error('Unknown function in release manifest');
  for (const name of names) {
    const { releaseId, code } = functions[name];
    if (
      !['uploaded', 'unchanged'].includes(code) ||
      (code === 'uploaded' ? releaseId !== deployedReleaseId : !commit.test(releaseId))
    )
      throw new Error(`Invalid release manifest entry: ${name}`);
  }
  return { schemaVersion: 1, deployedReleaseId, functions };
}

export function writeFunctionReleaseManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}

/** Absent before the first deploy that writes it: every function must report this commit. */
export function readFunctionReleaseManifest(path, deployedReleaseId) {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed?.schemaVersion !== 1 || parsed.deployedReleaseId !== deployedReleaseId)
    throw new Error('Function release manifest belongs to another deploy');
  return functionReleaseManifest(parsed.deployedReleaseId, parsed.functions ?? {});
}

/** The releaseId and deployedReleaseId one function's health must show. */
export function expectedFunctionRelease(manifest, service, currentReleaseId) {
  const entry = manifest?.functions?.[service];
  if (!entry) return { releaseId: currentReleaseId, deployedReleaseId: undefined };
  return { releaseId: entry.releaseId, deployedReleaseId: manifest.deployedReleaseId };
}
