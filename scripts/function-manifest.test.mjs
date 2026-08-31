/**
 * Manifest preservation contract (ARCHITECTURE §14, R1 M9/E1).
 *
 * Deploys REPLACE a function's live env wholesale, so the manifest-derived
 * admin/public-api definitions must stay BYTE-IDENTICAL to the pre-manifest
 * functionDefs literals — pinned here verbatim, including the optional-var
 * drop behavior. Any manifest edit that changes them fails this test before
 * it can un-set live env vars.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ALIBABA_SYNC_TIMER,
  DESIRED_TIMER_TRIGGERS,
  FUNCTION_NAMES,
  buildFunctionDefs,
  desiredTriggersFor,
  envEntries,
} from './cloudbase-function-manifest.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

const requireEnvFixture = (name) => {
  const values = {
    JWT_SECRET: 'jwt-secret-value',
    ADMIN_PASSWORD_HASH: 'admin-hash-value',
  };
  if (!(name in values)) throw new Error(`unexpected requireEnv(${name})`);
  return values[name];
};

const OPTIONAL_VALUES = {
  BOOTSTRAP_ADMIN_TOKEN: 'bootstrap-token',
  EMAIL_HOST: 'smtp.example.test',
  // Every other optional var is deliberately ABSENT to pin drop behavior.
};
const optionalEnvFixture = (name) => OPTIONAL_VALUES[name];

const ctx = {
  envId: 'env-test-id',
  appEnv: 'test',
  adminEmail: 'admin@channel.local',
  apiUrl: 'https://env-test-id.service.tcloudbase.com',
  siteUrl: 'https://channel-test-env-test-id.webapps.tcloudbase.com',
  corsAllowedOrigins: 'https://site.example,http://localhost:4321',
  loginUrl: 'https://site.example/login',
  resetPasswordUrl: 'https://site.example/reset',
  requireEnv: requireEnvFixture,
  optionalEnv: optionalEnvFixture,
};

test('manifest names, routes, and runtime limits are frozen', () => {
  assert.deepEqual(FUNCTION_NAMES, ['admin', 'public-api', 'alibaba-catalog-sync']);
  const defs = buildFunctionDefs(ctx);
  assert.deepEqual(
    defs.map(({ name, routePath, timeout, memorySize }) => ({
      name,
      routePath,
      timeout,
      memorySize,
    })),
    [
      { name: 'admin', routePath: '/api/admin', timeout: 20, memorySize: 256 },
      { name: 'public-api', routePath: '/api', timeout: 20, memorySize: 256 },
      {
        name: 'alibaba-catalog-sync',
        routePath: '/api/alibaba-catalog-sync',
        timeout: 900,
        memorySize: 512,
      },
    ],
  );
});

test('PRESERVATION: admin env map is byte-identical to the pre-manifest literal', () => {
  const admin = buildFunctionDefs(ctx).find((def) => def.name === 'admin');
  assert.deepEqual(admin.envVariables, {
    TCB_ENV: 'env-test-id',
    APP_ENV: 'test',
    ADMIN_EMAIL: 'admin@channel.local',
    JWT_SECRET: 'jwt-secret-value',
    ADMIN_PASSWORD_HASH: 'admin-hash-value',
    BOOTSTRAP_ENABLED: process.env.BOOTSTRAP_ENABLED || '0',
    BOOTSTRAP_ADMIN_TOKEN: 'bootstrap-token',
    CORS_ALLOWED_ORIGINS: 'https://site.example,http://localhost:4321',
    LOGIN_URL: 'https://site.example/login',
    RESET_PASSWORD_URL: 'https://site.example/reset',
    EMAIL_HOST: 'smtp.example.test',
    // EMAIL_PORT/SECURE/USER/PASSWORD/FROM absent -> DROPPED, never "undefined".
  });
  assert.equal('EMAIL_PORT' in admin.envVariables, false, 'optional-var drop preserved');
});

test('PRESERVATION: public-api env map is byte-identical to the pre-manifest literal', () => {
  const publicApi = buildFunctionDefs(ctx).find((def) => def.name === 'public-api');
  assert.deepEqual(publicApi.envVariables, {
    TCB_ENV: 'env-test-id',
    APP_ENV: 'test',
    PUBLIC_API_BASE_URL: 'https://env-test-id.service.tcloudbase.com',
    CORS_ALLOWED_ORIGINS: 'https://site.example,http://localhost:4321',
    JWT_SECRET: 'jwt-secret-value',
  });
});

test('alibaba-catalog-sync env carries the shared vars; feature vars stay optional', () => {
  const sync = buildFunctionDefs(ctx).find((def) => def.name === 'alibaba-catalog-sync');
  // Shared vars are REQUIRED for the connect flow (R1 H3).
  assert.equal(sync.envVariables.TCB_ENV, 'env-test-id');
  assert.equal(sync.envVariables.JWT_SECRET, 'jwt-secret-value');
  assert.equal(
    sync.envVariables.CORS_ALLOWED_ORIGINS,
    'https://site.example,http://localhost:4321',
  );
  assert.equal(
    sync.envVariables.SITE_URL,
    'https://channel-test-env-test-id.webapps.tcloudbase.com',
  );
  // Unset feature vars are dropped — cold start must not need them (R1 L12).
  for (const key of [
    'ALI_APP_KEY',
    'ALI_APP_SECRET',
    'ALI_OAUTH_CALLBACK_URL',
    'ALI_TOKEN_ENCRYPTION_KEY_V1',
    'WECOM_WEBHOOK_URL',
  ]) {
    assert.equal(key in sync.envVariables, false, `${key} dropped when unset`);
  }
});

test('sync is manual-only today: NO trigger is desired for any function', () => {
  // §14.1 — one live environment, timer deliberately off for the first
  // rollout. This test failing means someone enabled automatic sync; that is
  // a real decision, so update it deliberately rather than deleting it.
  assert.deepEqual(DESIRED_TIMER_TRIGGERS, {});
  assert.deepEqual(desiredTriggersFor('alibaba-catalog-sync'), []);
  assert.deepEqual(desiredTriggersFor('admin'), []);
});

test('the 15-minute tick stays DECLARED so enabling it is one edit', () => {
  assert.deepEqual(ALIBABA_SYNC_TIMER, {
    name: 'alibaba-sync-tick',
    type: 'timer',
    config: '0 */15 * * * * *',
  });
});

test('envEntries drops undefined and keeps empty strings', () => {
  assert.deepEqual(envEntries({ a: '1', b: undefined, c: '' }), { a: '1', c: '' });
});

test('admin tsup configuration bundles xlsx', () => {
  const config = readFileSync(join(root, 'apps', 'functions', 'admin', 'tsup.config.ts'), 'utf8');
  assert.match(config, /noExternal:\s*\[[\s\S]*['"]xlsx['"]/);
});

test('admin artifact packages xlsx and cold-starts without production dependencies', () => {
  run('pnpm', ['build:functions']);
  run(process.execPath, ['scripts/package-functions.mjs']);

  const artifactDir = join(root, '.cloudbase-artifacts', 'functions', 'admin');
  const bundle = readFileSync(join(artifactDir, 'index.js'), 'utf8');
  assert.doesNotMatch(bundle, /require\(["']xlsx["']\)/, 'xlsx must be bundled into admin');
  const artifactPackage = JSON.parse(readFileSync(join(artifactDir, 'package.json'), 'utf8'));
  assert.deepEqual(artifactPackage.dependencies, {});
  assert.equal(existsSync(join(artifactDir, 'node_modules')), false);

  const tempRoot = mkdtempSync(join(tmpdir(), 'channel-admin-artifact-'));
  const copiedArtifactDir = join(tempRoot, 'admin');
  try {
    cpSync(artifactDir, copiedArtifactDir, { recursive: true });
    const coldStart = run(
      process.execPath,
      [
        '-e',
        "const mod = require('./index.js'); if (typeof mod.main !== 'function') throw new Error('missing main export');",
      ],
      {
        cwd: copiedArtifactDir,
        env: {
          ...process.env,
          TCB_ENV: 'artifact-smoke-env',
          JWT_SECRET: 'artifact-smoke-jwt-secret',
          BOOTSTRAP_ENABLED: '0',
        },
      },
    );
    assert.equal(coldStart.stderr, '');
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test('artifact smoke rejects a residual xlsx import before cold start', () => {
  run('pnpm', ['build:functions']);
  run(process.execPath, ['scripts/package-functions.mjs']);

  const indexFile = join(root, '.cloudbase-artifacts', 'functions', 'admin', 'index.js');
  const original = readFileSync(indexFile, 'utf8');
  try {
    writeFileSync(indexFile, "require('xlsx');\nexports.main = () => {};\n", 'utf8');
    const smoke = spawnSync(process.execPath, ['scripts/smoke-function-artifacts.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(smoke.status, 0, 'the deliberately broken artifact must fail smoke');
    assert.match(
      `${smoke.stdout}\n${smoke.stderr}`,
      /admin artifact still contains xlsx require/,
      'the static unresolved-import check must report xlsx before cold start',
    );
  } finally {
    writeFileSync(indexFile, original, 'utf8');
  }
});
