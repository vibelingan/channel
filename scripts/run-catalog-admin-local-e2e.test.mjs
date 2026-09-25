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

test('taxonomy mutations run last with owned local database guards and real API calls', async () => {
  const source = await readFile('scripts/run-catalog-admin-local-e2e.mjs', 'utf8');
  assert.match(
    source,
    /\['test', 'tests\/e2e\/catalog-taxonomy\.spec\.ts'\],\s*e2eEnvironment,?\s*\);\s*\} finally/,
  );
  assert.match(source, /E2E_CATALOG_LOCAL_SEED: '1'/);
  assert.match(source, /E2E_CATALOG_LOCAL_DB: databaseFile/);
  assert.match(source, /E2E_ADMIN_EMAIL: 'admin@channel\.local'/);
  assert.match(source, /E2E_ADMIN_PASSWORD: 'admin'/);
  const spec = await readFile('tests/e2e/catalog-taxonomy.spec.ts', 'utf8');
  assert.match(spec, /const enabled = e2e\.catalogLocalSeed/);
  assert.match(spec, /test\.skip\(!enabled,/);
  assert.match(spec, /requireCatalogLocalSeedWhenEnabled\(enabled\)/);
  assert.match(spec, /requireAdminCredentialsWhenEnabled\(enabled,/);
  assert.match(spec, /!e2e\.allowMutation/);
  assert.match(spec, /e2e\.adminEmail !== 'admin@channel\.local'/);
  assert.match(spec, /e2e\.adminPassword !== 'admin'/);
  const ownershipCheck = spec.indexOf('expect(healthBody.data?.db).toBe(e2e.catalogLocalDb)');
  assert.ok(ownershipCheck > spec.indexOf("expect(healthBody.data?.mode).toBe('local')"));
  assert.ok(ownershipCheck < spec.indexOf('const session = await loginAdmin(request)'));
  assert.doesNotMatch(spec, /\.(?:route|routeFromHAR)\s*\(|route\.fulfill|as any/);
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.doesNotMatch(manifest.scripts['test:e2e:public'], /catalog-taxonomy/);
  assert.doesNotMatch(manifest.scripts['test:e2e:catalog'], /catalog-taxonomy/);
});

test('admin subcategory journey runs in every lane before taxonomy with owned local guards', async () => {
  const source = await readFile('scripts/run-catalog-admin-local-e2e.mjs', 'utf8');
  const journey = source.indexOf("'tests/e2e/admin-subcategory-visibility.spec.ts'");
  assert.ok(journey > source.indexOf('tests/e2e/catalog-formal-journey.spec.ts'));
  assert.ok(journey > source.indexOf('tests/e2e/admin-product-family-tabs.spec.ts'));
  assert.ok(journey < source.indexOf("'tests/e2e/catalog-taxonomy.spec.ts'"));
  const spec = await readFile('tests/e2e/admin-subcategory-visibility.spec.ts', 'utf8');
  assert.match(spec, /const enabled = e2e\.catalogLocalSeed/);
  assert.match(spec, /test\.skip\(!enabled,/);
  assert.match(spec, /requireCatalogLocalSeedWhenEnabled\(enabled\)/);
  assert.match(spec, /!e2e\.allowMutation/);
  const ownershipCheck = spec.indexOf('expect(healthBody.data?.db).toBe(e2e.catalogLocalDb)');
  assert.ok(ownershipCheck > 0 && ownershipCheck < spec.indexOf('await loginAdmin(request)'));
  assert.doesNotMatch(spec, /as any/);
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
