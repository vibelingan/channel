import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  smokeCatalogImageDecoder,
  usesCatalogImageDecoder,
} from './catalog-image-decoder-artifact.mjs';
import { FUNCTION_NAMES } from './cloudbase-function-manifest.mjs';
import { REQUIRED_NOSQL_RESOURCES } from './cloudbase-nosql-resources.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const artifactRoot = resolve(
  process.env.CHANNEL_FUNCTION_ARTIFACT_ROOT ?? join(root, '.cloudbase-artifacts', 'functions'),
);
const functions = FUNCTION_NAMES;

/** Artifact probes are offline fixtures, independent of the deploy job's switches and secrets. */
export function artifactSmokeEnvironment(parent = process.env, overrides = {}) {
  const inherited = Object.fromEntries(
    Object.entries(parent).filter(
      ([key]) => !key.startsWith('SALES_') && !key.startsWith('TENCENTCLOUD_'),
    ),
  );
  return {
    ...inherited,
    TCB_ENV: 'artifact-smoke-env',
    SCF_NAMESPACE: 'artifact-smoke-env',
    JWT_SECRET: 'artifact-smoke-jwt-secret',
    BOOTSTRAP_ENABLED: '0',
    TENCENTCLOUD_SECRETID: 'artifact-fake-id',
    TENCENTCLOUD_SECRETKEY: 'artifact-fake-key',
    TENCENTCLOUD_SESSIONTOKEN: 'artifact-fake-session',
    // Exercise the enabled production transport configuration without a real
    // customer identity, credential, endpoint or external request.
    SALES_SOURCE_CAPTURE_ENABLED: '1',
    SALES_SOURCE_DELIVERY_ENABLED: '1',
    SALES_CLIENT_ID: 'artifact-client',
    SALES_BUSINESS_LINE: 'website_sales',
    SALES_INSTALLATION_ID: 'artifact-site',
    SALES_ENVIRONMENT: 'production',
    SALES_SOURCE_CUTOVER_AT: '0',
    SALES_CONTROL_EPOCH: '1',
    SALES_RUNTIME_ID: 'artifact-runtime',
    SALES_CHANNEL_CONNECTION_ID: 'artifact-read',
    SALES_HERMES_EVENTS_URL: 'https://hermes.example.invalid/sales/events',
    SALES_HERMES_SOURCE_TOKEN: `artifact-source-${'s'.repeat(48)}`,
    SALES_RUNTIME_TOKEN: `artifact-runtime-${'r'.repeat(48)}`,
    ...overrides,
  };
}

function assertNoUnresolvedImports(name, indexFile) {
  const js = readFileSync(indexFile, 'utf8');
  const checks = [
    [/require\(["']@vibelingan-channel\//, 'workspace require'],
    [/from ["']@vibelingan-channel\//, 'workspace import'],
    [/require\(["']argon2["']\)/, 'native argon2 require'],
    [/require\(["']jose["']\)/, 'jose require'],
    [/require\(["']zod["']\)/, 'zod require'],
    [/require\(["']nodemailer["']\)/, 'nodemailer require'],
    [/require\(["']hash-wasm["']\)/, 'hash-wasm require'],
    [/require\(["']wx-server-sdk["']\)/, 'wx-server-sdk require'],
    [/require\(["']xlsx["']\)/, 'xlsx require'],
    [/require\(["']@cloudbase\/node-sdk["']\)/, '@cloudbase/node-sdk require'],
    [/require\(["']json-bigint["']\)/, 'json-bigint require'],
    [/require\(["']protobufjs/, 'protobufjs require'],
    [/require\(["']tslib["']\)/, 'tslib require'],
  ];

  for (const [pattern, label] of checks) {
    if (pattern.test(js)) {
      throw new Error(`${name} artifact still contains ${label}`);
    }
  }
}

export function smokeRequire(name, artifactDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), `channel-${name}-artifact-`));
  const tempFunctionDir = join(tempRoot, name);
  cpSync(artifactDir, tempFunctionDir, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "try { const mod = require('./index.js'); if (typeof mod.main !== 'function') throw new Error('missing main export'); } catch (error) { console.error(error.stack || String(error)); process.exitCode = 1; }",
    ],
    {
      cwd: tempFunctionDir,
      env: artifactSmokeEnvironment(),
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  rmSync(tempRoot, { force: true, recursive: true });

  if (result.status !== 0) {
    throw new Error(
      `${name} artifact cold-start smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function smokePublicCatalog(artifactDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'channel-public-behavior-'));
  try {
    cpSync(artifactDir, tempRoot, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/function-artifact-probe.cjs'), join(tempRoot, 'index.js')],
      {
        env: artifactSmokeEnvironment(process.env, {
          JWT_SECRET: 'artifact-smoke-jwt',
          CHANNEL_SMOKE_COLLECTIONS: JSON.stringify(
            REQUIRED_NOSQL_RESOURCES.map((r) => r.collectionName),
          ),
        }),
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    if (result.status !== 0)
      throw new Error(`public-api behavioral smoke failed\n${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
    const absentVariants = spawnSync(
      process.execPath,
      [join(root, 'scripts/function-artifact-probe.cjs'), join(tempRoot, 'index.js')],
      {
        env: artifactSmokeEnvironment(process.env, {
          JWT_SECRET: 'artifact-smoke-jwt',
          CHANNEL_SMOKE_COLLECTIONS: JSON.stringify(['products']),
        }),
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    if (
      absentVariants.status === 0 ||
      !/Missing collection: productVariants/.test(absentVariants.stderr)
    ) {
      throw new Error(
        'Missing-collection negative control did not reach the packaged variant query',
      );
    }
    console.log('public-api: missing collection negative control passed');
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function smokeAdminProductList(artifactDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'channel-admin-list-behavior-'));
  try {
    cpSync(artifactDir, tempRoot, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/admin-list-artifact-probe.cjs'), join(tempRoot, 'index.js')],
      { env: artifactSmokeEnvironment(), encoding: 'utf8', timeout: 15000 },
    );
    if (result.status !== 0)
      throw new Error(
        `admin native list artifact smoke failed\n${result.stdout}\n${result.stderr}`,
      );
    console.log(
      `admin: native list budget + full GET + fixed SDK projection passed\n${result.stdout.trim()}`,
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function smokeAdminProductWrites(artifactDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'channel-admin-write-behavior-'));
  try {
    cpSync(artifactDir, tempRoot, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/product-write-artifact-probe.cjs'), join(tempRoot, 'index.js')],
      { env: artifactSmokeEnvironment(), encoding: 'utf8', timeout: 15000 },
    );
    if (result.status !== 0)
      throw new Error(
        `admin native product write artifact smoke failed\n${result.stdout}\n${result.stderr}`,
      );
    console.log(
      `admin: native product write ACK + rollback + retry passed\n${result.stdout.trim()}`,
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export function smokeFunctionArtifacts() {
  for (const name of functions) {
    const artifactDir = join(artifactRoot, name);
    const indexFile = join(artifactDir, 'index.js');
    const packageFile = join(artifactDir, 'package.json');
    if (!existsSync(indexFile)) throw new Error(`Missing artifact entry: ${indexFile}`);
    if (!existsSync(packageFile)) throw new Error(`Missing artifact package.json: ${packageFile}`);

    assertNoUnresolvedImports(name, indexFile);
    smokeRequire(name, artifactDir);
    if (usesCatalogImageDecoder(readFileSync(indexFile, 'utf8'))) {
      const temp = mkdtempSync(join(tmpdir(), 'channel-pixel-smoke-'));
      try {
        cpSync(artifactDir, temp, { recursive: true });
        smokeCatalogImageDecoder(temp);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
    if (name === 'admin') {
      smokeAdminProductList(artifactDir);
      smokeAdminProductWrites(artifactDir);
    }
    if (name === 'public-api') smokePublicCatalog(artifactDir);
    console.log(`${name}: artifact smoke passed`);
  }
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  smokeFunctionArtifacts();
}
