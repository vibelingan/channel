import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCatalogProbe } from './catalog-probe-build.mjs';
test('the real probe bundle loads without workspace dependencies and rejects the wrong environment before SDK access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-probe-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = await buildCatalogProbe(join(root, 'function'));
  assert.ok(artifact.bytes > 0);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  const result = execFileSync(
    process.execPath,
    [
      '-e',
      "require('./index.js').main({action:'run'}).then(()=>process.exit(2),e=>{if(e.message!=='Wrong isolated probe target')throw e;process.stdout.write('target refused')})",
    ],
    {
      cwd: join(root, 'function'),
      env: { PATH: process.env.PATH, TCB_ENV: 'wrong' },
      timeout: 15000,
    },
  );
  assert.equal(result.toString(), 'target refused');
});
