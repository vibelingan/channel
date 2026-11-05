import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildReleaseRegional } from './release-regional-build.mjs';
import { normalizePolicy } from './release/ledger.mjs';
import { SITE_DELIVERY_POLICY } from './release/site-policy.mjs';

const execute = promisify(execFile);
const codeSha = 'b'.repeat(40);
const token = 'a'.repeat(64);

test('real SDK bundle loads in an empty directory and authenticates health on Node 20 without a database call', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'release-region-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const built = await buildReleaseRegional(directory, codeSha);
  const bytes = await readFile(join(directory, 'index.js'));
  assert.equal(built.bytes, bytes.length);
  assert.equal(built.sha256, createHash('sha256').update(bytes).digest('hex'));
  const node20 =
    process.env.NODE20_BIN ?? join(homedir(), '.local/share/mise/installs/node/20.19.0/bin/node');
  let runtime = process.execPath;
  try {
    await access(node20);
    runtime = node20;
  } catch {}
  await execute(runtime, ['--check', join(directory, 'index.js')]);
  const targetId = normalizePolicy(SITE_DELIVERY_POLICY).targetId;
  const ownerRunId = 'site-41313740695-1';
  const runnerRef = 'github:vibelingan/channel:41313740695:attempt-1';
  const request = {
    schemaVersion: 1,
    token,
    targetId,
    ownerRunId,
    runnerRef,
    codeSha,
    operationId: 'health-1',
    method: 'health',
    args: [],
  };
  const { releaseRegionalInputHash } = await import('./release/regional-coordinator.mjs');
  request.inputHash = releaseRegionalInputHash(request);
  const program = `const assert=require('node:assert/strict'); const {main}=require('./index.js');
    (async()=>{ const result=await main(${JSON.stringify(request)});
      assert.equal(result.ok,true); assert.equal(result.result.ready,true);
      assert.equal(result.codeSha,${JSON.stringify(codeSha)});
      assert.equal(Object.hasOwn(result,'tokenDigest'),false);
      const denied=await main({...${JSON.stringify(request)},token:'c'.repeat(64)});
      assert.equal(denied.ok,false); console.log('isolated-health-passed'); })().catch(e=>{console.error(e);process.exitCode=1;});`;
  const result = await execute(runtime, ['-e', program], {
    cwd: directory,
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      TCB_ENV: SITE_DELIVERY_POLICY.envId,
      RELEASE_REGIONAL_TARGET_ID: targetId,
      RELEASE_REGIONAL_OWNER_RUN_ID: ownerRunId,
      RELEASE_REGIONAL_RUNNER_REF: runnerRef,
      RELEASE_REGIONAL_TOKEN_DIGEST: createHash('sha256').update(token).digest('hex'),
      RELEASE_REGIONAL_SITE_ORIGIN: SITE_DELIVERY_POLICY.siteOrigin,
      RELEASE_REGIONAL_REPOSITORY: SITE_DELIVERY_POLICY.repository,
    },
  });
  assert.match(result.stdout, /isolated-health-passed/);
  assert.doesNotMatch(
    bytes.toString(),
    /require\(["'](?:@cloudbase\/node-sdk|@cloudbase\/database|zod)["']\)/,
  );
});

test('a missing or nonexact source SHA is rejected before building', async () => {
  await assert.rejects(buildReleaseRegional('/unused', 'branch-name'));
  await assert.rejects(buildReleaseRegional('/unused', undefined));
});
