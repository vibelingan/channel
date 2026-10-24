import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const sha = process.env.CHANNEL_BUILD_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Exact bundle code SHA required');
const output = execFileSync(
  process.execPath,
  [
    '-e',
    `const api=require(process.argv[1]);Promise.all([api.main({action:'health'}),api.main({action:'articleDrafts',data:{operation:'list'}}),api.main({action:'update',data:{collection:'products'}})]).then(value=>process.stdout.write(JSON.stringify(value)));`,
    resolve('apps/functions/admin/dist-blog-dummy/index.js'),
  ],
  {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      PATH: process.env.PATH,
      TCB_ENV: 'diversity-123-d9grnqfux221323bb',
      BLOG_DUMMY_ENABLED: '1',
      BLOG_DUMMY_EXPECTED_CODE_SHA: sha,
      BLOG_DUMMY_EXPIRES_AT: new Date(Date.now() + 300000).toISOString(),
      BLOG_DUMMY_JWT_SECRET: 'bundle-only-fake-key-at-least-thirty-two-bytes',
    },
  },
);
const result = JSON.parse(output);
assert.equal(result[0].data.codeSha, sha);
assert.equal(result[1].error.code, 'UNAUTHORIZED');
assert.equal(result[2].error.code, 'VALIDATION_ERROR');
console.log(
  'Actual bundled dummy function health and access boundaries passed without cloud credentials.',
);

// Load the real worker dependency graph with the same runner used by Actions.
const worker = spawnSync(
  process.execPath,
  [resolve('apps/site/node_modules/tsx/dist/cli.mjs'), 'scripts/blog/dummy-worker.ts', 'prepare'],
  { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } },
);
assert.equal(worker.status, 1);
assert.match(worker.stderr, /Untrusted isolated Blog invocation/);
assert.doesNotMatch(worker.stderr, /ERR_INVALID_TYPESCRIPT_SYNTAX|Cannot find module/);
console.log(
  'Actual delivery worker loaded and rejected an untrusted invocation before cloud access.',
);
