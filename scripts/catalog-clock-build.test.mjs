import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCatalogClock } from './catalog-clock-build.mjs';
test('standalone clock has no workspace dependency and the disabled switch performs no SDK calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = await buildCatalogClock(join(root, 'function'));
  assert.ok(artifact.bytes > 0);
  const output = execFileSync(
    process.execPath,
    ['-e', "require('./index.js').main({}).then(r=>process.stdout.write(r.status))"],
    {
      cwd: join(root, 'function'),
      env: { PATH: process.env.PATH, TCB_ENV: 'diversity-123-d9grnqfux221323bb' },
      timeout: 15000,
    },
  );
  assert.equal(output.toString(), 'disabled');
  const denied = execFileSync(
    process.execPath,
    [
      '-e',
      "require('./index.js').main({}).then(()=>process.exit(2),e=>process.stdout.write(e.message))",
    ],
    {
      cwd: join(root, 'function'),
      env: { PATH: process.env.PATH, TCB_ENV: 'wrong' },
      timeout: 15000,
    },
  );
  assert.equal(denied.toString(), 'Wrong catalog clock target');
});
