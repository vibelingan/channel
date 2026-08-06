import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUNCTION_NAMES } from './cloudbase-function-manifest.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const artifactRoot = join(root, '.cloudbase-artifacts', 'functions');
const functions = FUNCTION_NAMES;

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

function smokeRequire(name, artifactDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), `channel-${name}-artifact-`));
  const tempFunctionDir = join(tempRoot, name);
  cpSync(artifactDir, tempFunctionDir, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const mod = require('./index.js'); if (typeof mod.main !== 'function') throw new Error('missing main export');",
    ],
    {
      cwd: tempFunctionDir,
      env: {
        ...process.env,
        TCB_ENV: 'artifact-smoke-env',
        JWT_SECRET: 'artifact-smoke-jwt-secret',
        BOOTSTRAP_ENABLED: '0',
      },
      encoding: 'utf8',
    },
  );
  rmSync(tempRoot, { force: true, recursive: true });

  if (result.status !== 0) {
    throw new Error(
      `${name} artifact cold-start smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

for (const name of functions) {
  const artifactDir = join(artifactRoot, name);
  const indexFile = join(artifactDir, 'index.js');
  const packageFile = join(artifactDir, 'package.json');
  if (!existsSync(indexFile)) throw new Error(`Missing artifact entry: ${indexFile}`);
  if (!existsSync(packageFile)) throw new Error(`Missing artifact package.json: ${packageFile}`);

  assertNoUnresolvedImports(name, indexFile);
  smokeRequire(name, artifactDir);
  console.log(`${name}: artifact smoke passed`);
}
