import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const site = fileURLToPath(new URL('..', import.meta.url));

/**
 * The three slowest files take ~185 s, ~155 s and ~102 s: over half of all site test time
 * (~750 s, measured 2026-11-11). They run in one CI shard; every other file, including any
 * file added later, runs in the other. Measured locally: 172 s and 257 s with the first two.
 */
export const HEAVY_SITE_TEST_FILES = Object.freeze([
  'src/islands/admin/catalog-list-readiness-browser.test.ts',
  'src/islands/admin/catalog-editor-recovery-browser.test.ts',
  'src/islands/admin/classification-publication-browser.test.ts',
]);

/** Every file the package test script's `src/**\/*.test.ts` glob matches, sorted. */
export function siteTestFiles(directory = site) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.test.ts'))
        files.push(relative(directory, path).split('\\').join('/'));
    }
  };
  walk(join(directory, 'src'));
  return files.sort();
}

export function siteTestShard(name, files = siteTestFiles()) {
  if (name === 'heavy') {
    const missing = HEAVY_SITE_TEST_FILES.filter((file) => !files.includes(file));
    if (missing.length) throw new Error(`Heavy site test files are missing: ${missing.join(', ')}`);
    return [...HEAVY_SITE_TEST_FILES];
  }
  if (name === 'rest') return files.filter((file) => !HEAVY_SITE_TEST_FILES.includes(file));
  throw new Error('Site test shard must be heavy or rest');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = siteTestShard(process.argv[2]);
  const child = spawn(
    join(site, 'node_modules', '.bin', 'tsx'),
    ['--test', '--test-concurrency=2', ...files],
    { cwd: site, stdio: 'inherit' },
  );
  child.once('error', (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
