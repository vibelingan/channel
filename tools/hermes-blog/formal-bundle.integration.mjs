import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('formal publisher bundle performs a private maintenance check on the actual runtime without source or dependencies', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'channel-blog-formal-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'credential.json');
  const program = join(dir, 'invoke.mjs');
  await copyFile(resolve('output/hermes-blog-bundle/channel-blog-invoke.mjs'), program);
  const secret = 'f'.repeat(64);
  const credential = `test.${secret}`;
  await writeFile(
    file,
    JSON.stringify({
      CHANNEL_BLOG_API_ORIGIN:
        'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
      CHANNEL_BLOG_SITE_ORIGIN: 'https://supplychainsai.com',
      CHANNEL_BLOG_INTEGRATION_ID: 'formal-connection',
      CHANNEL_BLOG_CREDENTIAL: credential,
      CHANNEL_BLOG_MAINTENANCE: {
        expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
        rotateAfter: new Date(Date.now() + 30 * 86400000).toISOString(),
        configRevision: 1,
      },
    }),
    { mode: 0o600 },
  );
  const result = await exec(process.execPath, [program, '--credential', file, '--maintain'], {
    cwd: dir,
    timeout: 10000,
  });
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert(!result.stdout.includes(secret));
  assert.equal(result.stderr, '');
  const locked = await exec(
    'python3',
    [
      resolve('tools/hermes-blog/locked-invoke.py'),
      '--node',
      process.execPath,
      '--bundle',
      program,
      '--credential',
      file,
      '--maintain',
    ],
    { cwd: dir, timeout: 10000 },
  );
  assert.equal(JSON.parse(locked.stdout).ok, true);
  assert(!locked.stdout.includes(secret));
});
