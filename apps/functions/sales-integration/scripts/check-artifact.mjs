import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'sales-artifact-'));
try {
  await cp(new URL('../dist/package/', import.meta.url), directory, { recursive: true });
  assert.ok((await stat(join(directory, 'scf_bootstrap'))).mode & 0o111);
  assert.ok(
    (await readFile(join(directory, 'scf_bootstrap'), 'utf8')).includes(
      '/var/lang/node20/bin/node index.js',
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const {createSalesRuntime} = require('./index.js');
    assert.equal(typeof createSalesRuntime, 'function');
    createSalesRuntime()({method:'GET',url:'/inquiries/oem/one',headers:{}}).then(result => {
      assert.equal(result.status,404);
      assert.equal(JSON.parse(result.body).code,'NOT_ENABLED');
    }).catch(error => { console.error(error);process.exitCode=1; });
  `,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, SALES_INTEGRATION_ENABLED: '0' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  console.log(
    'Built artifact loads without workspace, node_modules or schema sidecars; disabled runtime stays closed.',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
