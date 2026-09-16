import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('catalog acceptance uses isolated production artifacts and cannot inherit CloudBase media configuration', async () => {
  const source = await readFile('scripts/run-catalog-admin-local-e2e.mjs', 'utf8');
  assert.match(source, /\['build', '--outDir', siteDirectory\]/);
  assert.match(source, /\['preview', '--outDir', siteDirectory/);
  assert.doesNotMatch(source, /\['dev',/);
  assert.match(source, /PUBLIC_API_BASE_URL: apiUrl/);
  assert.match(source, /TCB_ENV: ''/);
  for (const spec of [
    'public.spec.ts',
    'sku-detail.spec.ts',
    'catalog-category.spec.ts',
    'catalog-family-routes.spec.ts',
    'catalog-hub.spec.ts',
    'header-navigation.spec.ts',
  ]) {
    assert.ok(source.includes(`tests/e2e/${spec}`), `${spec} must run before deployment`);
  }
});

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
