import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { artifactSmokeEnvironment, smokeRequire } from './smoke-function-artifacts.mjs';

test('artifact subprocesses cannot inherit production Sales or cloud credentials', () => {
  const parent = {
    PATH: '/bin',
    SALES_SOURCE_DELIVERY_ENABLED: '0',
    SALES_RESEND_API_KEY: 'canary',
    SALES_HERMES_SOURCE_TOKEN: 'real-source-canary',
    TENCENTCLOUD_SECRETKEY: 'real-cloud-canary',
  };
  const env = artifactSmokeEnvironment(parent);
  assert.equal(env.PATH, parent.PATH);
  assert.equal(env.SALES_RESEND_API_KEY, undefined);
  assert.equal(env.SALES_SOURCE_DELIVERY_ENABLED, '1');
  assert.doesNotMatch(JSON.stringify(env), /canary/);
  assert.equal(parent.SALES_SOURCE_DELIVERY_ENABLED, '0');
});

test('artifact cold start supplies an isolated complete Sales configuration when the deploy job enables it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sales-artifact-env-'));
  const keys = [
    'SALES_SOURCE_CAPTURE_ENABLED',
    'SALES_SOURCE_DELIVERY_ENABLED',
    'SALES_HERMES_SOURCE_TOKEN',
    'SALES_CLIENT_ID',
    'SALES_HERMES_EVENTS_URL',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    // Reproduce the deployment job: switches and identity are job-wide,
    // whereas real credentials are deliberately absent from the smoke step.
    Object.assign(process.env, {
      SALES_SOURCE_CAPTURE_ENABLED: '1',
      SALES_SOURCE_DELIVERY_ENABLED: '1',
      SALES_CLIENT_ID: 'host-production-client',
      SALES_HERMES_EVENTS_URL: 'https://production.example/sales/events',
    });
    Reflect.deleteProperty(process.env, 'SALES_HERMES_SOURCE_TOKEN');
    writeFileSync(
      join(dir, 'index.js'),
      `
      const assert = require('node:assert/strict');
      assert.equal(process.env.SALES_SOURCE_CAPTURE_ENABLED, '1');
      assert.equal(process.env.SALES_SOURCE_DELIVERY_ENABLED, '1');
      assert.equal(process.env.SALES_CLIENT_ID, 'artifact-client');
      assert.equal(process.env.SALES_ENVIRONMENT, 'production');
      assert.equal(process.env.TCB_ENV, 'artifact-smoke-env');
      assert.equal(process.env.SALES_HERMES_EVENTS_URL, 'https://hermes.example.invalid/sales/events');
      assert.match(process.env.SALES_HERMES_SOURCE_TOKEN, /^[A-Za-z0-9_-]{32,512}$/);
      assert.notEqual(process.env.SALES_HERMES_SOURCE_TOKEN, process.env.SALES_RUNTIME_TOKEN);
      exports.main = () => {};
    `,
    );
    assert.doesNotThrow(() => smokeRequire('sales-fixture', dir));
    assert.equal(process.env.SALES_CLIENT_ID, 'host-production-client');
    assert.equal(process.env.SALES_HERMES_SOURCE_TOKEN, undefined);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact cold start still rejects broken modules and reports the actual short error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broken-artifact-'));
  try {
    writeFileSync(
      join(dir, 'index.js'),
      `const longLine = '${'x'.repeat(80000)}'; throw new Error('COLD_START_DEFECT');`,
    );
    assert.throws(
      () => smokeRequire('broken-fixture', dir),
      (error) => {
        assert.match(error.message, /COLD_START_DEFECT/);
        assert.ok(
          error.message.length < 5000,
          'source excerpts must not hide the actual exception',
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calling the smoke CLI through a symlink still checks and rejects a broken artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-cli-entry-'));
  try {
    const artifacts = join(dir, 'artifacts');
    const admin = join(artifacts, 'admin');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'index.js'), "require('xlsx'); exports.main = () => {};\n");
    writeFileSync(join(admin, 'package.json'), '{}\n');
    const script = join(dir, 'smoke.mjs');
    symlinkSync(fileURLToPath(new URL('./smoke-function-artifacts.mjs', import.meta.url)), script);
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CHANNEL_FUNCTION_ARTIFACT_ROOT: artifacts },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /admin artifact still contains xlsx require/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
