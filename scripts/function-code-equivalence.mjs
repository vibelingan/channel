import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const commit = /^[a-f0-9]{40}$/;
const stampTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const safeEntry = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+/-]{1,200}$/;

function localFiles(directory) {
  const files = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(relative(directory, path).split('\\').join('/'), path);
      else throw new Error('Unexpected artifact entry');
    }
  };
  walk(directory);
  return files;
}

function zipFiles(zipPath, run) {
  const listed = run('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
    .split('\n')
    .filter(Boolean)
    .filter((name) => !name.endsWith('/'));
  if (!listed.length || new Set(listed).size !== listed.length) throw new Error('Bad deployed ZIP');
  for (const name of listed) if (!safeEntry.test(name)) throw new Error('Unsafe deployed entry');
  return listed;
}

function readZipEntry(zipPath, name, run) {
  return run('unzip', ['-p', zipPath, name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * True only when the deployed package equals the new artifact once the new build stamp is
 * replaced by the deployed one. Every other answer, including any error, means "upload".
 */
export function provenUnchangedFunctionCode({
  artifactDir,
  deployedZip,
  deployedStamp,
  currentStamp,
  run = execFileSync,
}) {
  try {
    for (const stamp of [deployedStamp, currentStamp])
      if (!commit.test(stamp?.releaseId ?? '') || !stampTime.test(stamp?.buildTime ?? ''))
        return false;
    const local = localFiles(artifactDir);
    const deployed = zipFiles(deployedZip, run);
    if (deployed.length !== local.size || deployed.some((name) => !local.has(name))) return false;
    for (const name of deployed) {
      const ours = readFileSync(local.get(name));
      const theirs = readZipEntry(deployedZip, name, run);
      if (name !== 'index.js') {
        if (!ours.equals(theirs)) return false;
        continue;
      }
      const source = ours.toString('utf8');
      const quoted = (value) => JSON.stringify(value);
      // Both stamp values must be present, or the build stamp is not where this proof expects it.
      if (
        !source.includes(quoted(currentStamp.releaseId)) ||
        !source.includes(quoted(currentStamp.buildTime))
      )
        return false;
      const restamped = source
        .replaceAll(quoted(currentStamp.releaseId), quoted(deployedStamp.releaseId))
        .replaceAll(quoted(currentStamp.buildTime), quoted(deployedStamp.buildTime));
      if (!Buffer.from(restamped, 'utf8').equals(theirs)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
