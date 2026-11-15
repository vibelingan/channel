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
  const reconcile = spawnSync(process.execPath, ['reconcile.js'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, SALES_SOURCE_DELIVERY_ENABLED: '0' },
  });
  assert.equal(reconcile.status, 0, reconcile.stderr);
  assert.deepEqual(JSON.parse(reconcile.stdout), {
    state: 'disabled',
    wrapped: false,
    results: [],
  });

  const enabled = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    for (const name of ['node:http', 'node:https']) require(name).request = () => { throw new Error('Network forbidden in artifact constructor probe'); };
    globalThis.fetch = () => { throw new Error('Network forbidden in artifact constructor probe'); };
    const {configuredWebsiteDelivery} = require('./reconcile.js');
    const worker = configuredWebsiteDelivery({
      SALES_SOURCE_DELIVERY_ENABLED:'1', SALES_CLIENT_ID:'client_a', SALES_BUSINESS_LINE:'website_sales',
      SALES_INSTALLATION_ID:'site_a', SALES_ENVIRONMENT:'test', TCB_ENV:'offline-artifact-env',
      SALES_SOURCE_CUTOVER_AT:'0', SALES_CONTROL_EPOCH:'1', SALES_RUNTIME_ID:'runtime_a',
      SALES_CHANNEL_CONNECTION_ID:'agent_a', SALES_HERMES_EVENTS_URL:'http://127.0.0.1:1/sales/events',
      SALES_HERMES_SOURCE_TOKEN:'s'.repeat(48), AGENT_a:'r'.repeat(48),
    });
    assert.equal(typeof worker.tick, 'function');
  `,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15000,
      // The installed SDK otherwise probes cloud metadata asynchronously at init.
      env: { ...process.env, TENCENTCLOUD_RUNENV: 'SCF' },
    },
  );
  assert.equal(enabled.status, 0, enabled.stderr);

  console.log(
    'Built artifact loads without workspace, node_modules or schema sidecars; disabled runtime stays closed.',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
