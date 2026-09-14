import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import test from 'node:test';

async function runFailure(stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/run-catalog-admin-local-e2e.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, E2E_CATALOG_RUNNER_FAIL_STAGE: stage },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

for (const stage of ['api', 'site']) {
  test(`catalog local runner removes its temporary directory after ${stage} spawn failure`, async () => {
    const result = await runFailure(stage);
    assert.notEqual(result.code, 0);
    const removedDirectory = result.output
      .match(/\[catalog-admin-local\] removed (.+)/)?.[1]
      ?.trim();
    assert.ok(removedDirectory, result.output);
    await assert.rejects(access(removedDirectory));
  });
}
