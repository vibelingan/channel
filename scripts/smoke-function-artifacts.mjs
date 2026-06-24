import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const artifactRoot = join(root, '.cloudbase-artifacts', 'functions');
const functions = ['admin', 'public-api'];

const platformStub = `module.exports = {
  init() {},
  database() {
    return {
      command: {},
      collection() {
        throw new Error('wx-server-sdk database stub should not be used during cold-start smoke');
      }
    };
  }
};
`;

function assertNoUnresolvedImports(name, indexFile) {
  const js = readFileSync(indexFile, 'utf8');
  const checks = [
    [/require\(["']@vibelingan-channel\//, 'workspace require'],
    [/from ["']@vibelingan-channel\//, 'workspace import'],
    [/require\(["']argon2["']\)/, 'native argon2 require'],
  ];

  for (const [pattern, label] of checks) {
    if (pattern.test(js)) {
      throw new Error(`${name} artifact still contains ${label}`);
    }
  }
}

function writeCloudBaseStub(functionDir) {
  const moduleDir = join(functionDir, 'node_modules', 'wx-server-sdk');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, 'index.js'), platformStub, 'utf8');
}

function smokeRequire(name, artifactDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), `channel-${name}-artifact-`));
  const tempFunctionDir = join(tempRoot, name);
  cpSync(artifactDir, tempFunctionDir, { recursive: true });
  writeCloudBaseStub(tempFunctionDir);

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
