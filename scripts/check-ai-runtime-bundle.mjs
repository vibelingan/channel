import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const files = process.argv.slice(2).map((file) => resolve(file));
if (files.length === 0) throw new Error('bundle path is required');

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

for (const emitted of files) {
  const source = readFileSync(emitted, 'utf8');
  const invalid = source.match(/(?:from|import\()\s*["'](?:test|assert)["']/);
  if (invalid) {
    throw new Error(`${emitted} contains a test-only bare Node import: ${invalid[0]}`);
  }

  // Cold-import the actual Docker runtime stage. It contains only the emitted
  // artifact and `pnpm deploy --prod` dependencies, so a workspace or dev
  // dependency cannot resolve accidentally from the monorepo.
  const packageRoot = dirname(dirname(emitted));
  const dockerfile = join(packageRoot, 'Dockerfile');
  const tag = `channel-ai-runtime-check-${basename(packageRoot)}:${randomUUID()}`;
  try {
    execFileSync(
      'docker',
      ['build', '--target', 'runtime', '--file', dockerfile, '--tag', tag, repoRoot],
      { cwd: repoRoot, stdio: 'pipe', timeout: 300_000 },
    );
    const artifactInImage = `./dist/${basename(emitted)}`;
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'node',
        tag,
        '--input-type=module',
        '--eval',
        `import('${artifactInImage}')`,
      ],
      { cwd: repoRoot, stdio: 'pipe', timeout: 30_000 },
    );
  } catch (error) {
    throw new Error(`cold runtime import failed for ${relative(repoRoot, emitted)}`, {
      cause: error,
    });
  } finally {
    try {
      execFileSync('docker', ['image', 'rm', '--force', tag], {
        cwd: repoRoot,
        stdio: 'ignore',
        timeout: 30_000,
      });
    } catch {
      // A failed build may never create the temporary image.
    }
  }
}
