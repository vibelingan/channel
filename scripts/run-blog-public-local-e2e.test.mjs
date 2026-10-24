import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('Blog local runner cleans its owned directories when a build tool cannot start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blog-runner-missing-tool-'));
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./run-blog-public-local-e2e.mjs', import.meta.url)), '--build-only'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.notEqual(code, 0);
    const directory = output.match(/\[blog-public\] Removed owned temporary directory (.+)/)?.[1];
    assert.ok(directory, output);
    await assert.rejects(access(directory));
    assert.deepEqual(await readdir(join(root, 'apps/site/.astro')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
