import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const functionZipLimit = 1.5 * 1024 * 1024;
export const functionBuildPolicy = Object.freeze({
  format: 'channel-bundled-zip-v1',
  transport: 'inline-zip',
  maxBytes: functionZipLimit,
  installDependency: false,
});

/** Keep the archived ZIP unchanged; extraction is only for a credential-free cold-start check. */
export function checkFunctionArchive(input, { smoke = false } = {}) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > functionZipLimit)
    throw new Error('Function ZIP exceeds the supported inline scope');
  const directory = smoke ? mkdtempSync(join(tmpdir(), 'release-function-smoke-')) : null;
  try {
    const archive = spawnSync(
      'python3',
      [
        fileURLToPath(new URL('./check-function-zip.py', import.meta.url)),
        ...(directory ? [directory] : []),
      ],
      { input: bytes, timeout: 10_000, maxBuffer: 65_536 },
    );
    if (archive.status !== 0) throw new Error('Invalid bundled function ZIP');
    if (directory) {
      const result = spawnSync(
        process.execPath,
        ['-e', "if (typeof require('./index.js').main !== 'function') process.exit(1)"],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            TCB_ENV: 'artifact-smoke-env',
            JWT_SECRET: 'artifact-smoke-secret',
            BOOTSTRAP_ENABLED: '0',
          },
          timeout: 15_000,
          maxBuffer: 65_536,
        },
      );
      if (result.status !== 0) throw new Error('Archived function cold-start check failed');
    }
    return JSON.parse(archive.stdout.toString('utf8'));
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
