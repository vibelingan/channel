import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadDummyFunction } from '../release/dummy-recovery-fixture.mjs';
import { checkFunctionArchive } from '../release/function-archive.mjs';
import { buildLiveDummyFunction } from './build-function.mjs';
import { dummyFunctionConfiguration } from './runtime.mjs';
test('the actual SDK is bundled in the standalone live function; archived A still preserves B data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'live-dummy-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = await buildLiveDummyFunction({
    directory: join(root, 'A'),
    version: 'A',
    codeSha: 'a'.repeat(40),
  });
  const b = await buildLiveDummyFunction({
    directory: join(root, 'B'),
    version: 'B',
    codeSha: 'a'.repeat(40),
  });
  assert.notDeepEqual(a.bytes, b.bytes);
  checkFunctionArchive(a.bytes, { smoke: true });
  const actual = join(root, 'real-handler');
  mkdirSync(actual);
  execFileSync(
    'python3',
    [new URL('../release/check-function-zip.py', import.meta.url).pathname, actual],
    { input: a.bytes },
  );
  const token = 'f'.repeat(64);
  const health = execFileSync(
    process.execPath,
    [
      '-e',
      `const main=require('./index.js').main;main({action:'health',token:'${token}'}).then(x=>process.stdout.write(JSON.stringify(x)));`,
    ],
    {
      cwd: actual,
      env: {
        PATH: process.env.PATH,
        ...dummyFunctionConfiguration('123', createHash('sha256').update(token).digest('hex'))
          .envVariables,
      },
      timeout: 15000,
    },
  );
  assert.deepEqual(JSON.parse(health.toString()), {
    purpose: 'channel-recovery-dummy-v1',
    version: 'A',
    codeSha: 'a'.repeat(40),
    runId: '123',
  });
  const loaded = loadDummyFunction(a.bytes);
  t.after(loaded.close);
  assert.equal((await loaded.main({ action: 'health' })).version, 'A');
  const record = {
    _id: 'seo-drill-example',
    purpose: 'channel-recovery-dummy-v1',
    label: 'B',
    note: 'keep new field',
    revision: 2,
    deleted: false,
  };
  const result = await loaded.main({
    action: 'update',
    id: record._id,
    record,
    patch: { label: 'A' },
  });
  assert.equal(result.record.note, 'keep new field');
  await assert.rejects(
    buildLiveDummyFunction({ directory: join(root, 'A'), version: 'A', codeSha: 'a'.repeat(40) }),
  );
});
