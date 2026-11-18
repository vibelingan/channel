import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { smokeCatalogImageDecoder } from './catalog-image-decoder-artifact.mjs';
import { buildSourceMediaProbe } from './source-media-probe-build.mjs';

test('the packaged source probe loads with real native pixels and rejects before cloud access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'source-image-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'function');
  const artifact = await buildSourceMediaProbe(directory, `${process.platform}-${process.arch}`);
  assert.ok(artifact.bytes > 0);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  smokeCatalogImageDecoder(directory);
  const reply = execFileSync(
    process.execPath,
    [
      '-e',
      "require('./index.js').main({action:'run'}).then(()=>process.exit(2),e=>{if(e.message.indexOf('Wrong source probe environment')<0)throw e;process.stdout.write('target refused')})",
    ],
    { cwd: directory, env: { PATH: process.env.PATH, TCB_ENV: 'wrong' }, timeout: 15000 },
  );
  assert.equal(reply.toString(), 'target refused');
});
