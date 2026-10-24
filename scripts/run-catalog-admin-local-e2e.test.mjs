import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import test from 'node:test';
import { catalogE2eSuites } from './catalog-e2e-suites.mjs';

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
    assert.ok(
      catalogE2eSuites({ formal: false }).flat().includes(`tests/e2e/${spec}`),
      `${spec} must run before deployment`,
    );
  }
});

test('taxonomy mutations run last with owned local database guards and real API calls', async () => {
  const source = await readFile('scripts/run-catalog-admin-local-e2e.mjs', 'utf8');
  for (const formal of [true, false])
    assert.deepEqual(catalogE2eSuites({ formal }).at(-1), ['tests/e2e/catalog-taxonomy.spec.ts']);
  assert.match(source, /for \(const specs of browserSuites\)/);
  assert.match(source, /\['test', \.\.\.specs\], e2eEnvironment/);
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
  for (const formal of [true, false]) {
    const suites = catalogE2eSuites({ formal }).flat();
    const journey = suites.indexOf('tests/e2e/admin-subcategory-visibility.spec.ts');
    assert.ok(
      journey >
        suites.indexOf(
          formal
            ? 'tests/e2e/catalog-formal-journey.spec.ts'
            : 'tests/e2e/admin-product-family-tabs.spec.ts',
        ),
    );
    assert.ok(journey < suites.indexOf('tests/e2e/catalog-taxonomy.spec.ts'));
  }
  const spec = await readFile('tests/e2e/admin-subcategory-visibility.spec.ts', 'utf8');
  assert.match(spec, /const enabled = e2e\.catalogLocalSeed/);
  assert.match(spec, /test\.skip\(!enabled,/);
  assert.match(spec, /requireCatalogLocalSeedWhenEnabled\(enabled\)/);
  assert.match(spec, /!e2e\.allowMutation/);
  const ownershipCheck = spec.indexOf('expect(healthBody.data?.db).toBe(e2e.catalogLocalDb)');
  assert.ok(ownershipCheck > 0 && ownershipCheck < spec.indexOf('await loginAdmin(request)'));
  assert.doesNotMatch(spec, /as any/);
  assert.ok(spec.indexOf('test.beforeEach(') < spec.indexOf("test('product creation"));
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
    child.once('close', (code) => resolve({ code, output }));
  });
}

for (const stage of ['api', 'build', 'site']) {
  test(`catalog local runner removes its temporary directory after ${stage} spawn failure`, async () => {
    const result = await runFailure(stage);
    assert.notEqual(result.code, 0);
    if (stage === 'site') {
      assert.doesNotMatch(
        result.output,
        /EXDEV/,
        'The build must succeed across repository and OS temporary volumes.',
      );
      assert.match(
        result.output,
        /missing-site/,
        'Failure must reach the intended preview spawn, after a real build.',
      );
    }
    const buildDirectory = result.output.match(/\[catalog-admin-local\] build (.+)/)?.[1]?.trim();
    assert.ok(buildDirectory, result.output);
    assert.equal(dirname(buildDirectory), resolve('apps/site'));
    assert.ok(basename(buildDirectory).startsWith('.catalog-e2e-build-'));
    const removedDirectories = [
      ...result.output.matchAll(/\[catalog-admin-local\] removed (.+)/g),
    ].map((match) => match[1].trim());
    assert.equal(new Set(removedDirectories).size, 2, result.output);
    assert.ok(removedDirectories.includes(buildDirectory));
    for (const directory of removedDirectories)
      await assert.rejects(access(directory), { code: 'ENOENT' });
  });
}

for (const mode of ['cloud', 'foreign-local-db']) {
  test(`admin journey refuses ${mode} before login or writes`, { timeout: 60_000 }, async (t) => {
    const directory = await mkdtemp(`${tmpdir()}/channel-catalog-ownership-`);
    const calls = [];
    const server = createServer((request, response) => {
      calls.push(request.url);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ok: true,
          data: { mode: mode === 'cloud' ? 'cloud' : 'local', db: 'foreign-db' },
        }),
      );
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(
      process.execPath,
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        'tests/e2e/admin-subcategory-visibility.spec.ts',
        '--grep',
        'built creation recovery',
        '--workers=1',
        '--reporter=line',
        '--output',
        directory,
      ],
      {
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          E2E_SITE_URL: url,
          E2E_API_URL: url,
          E2E_ADMIN_EMAIL: 'admin@channel.local',
          E2E_ADMIN_PASSWORD: 'admin',
          E2E_ALLOW_MUTATION: '1',
          E2E_CATALOG_LOCAL_SEED: '1',
          E2E_CATALOG_LOCAL_DB: 'owned-gate-db',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.notEqual(code, 0, output);
    assert.deepEqual(calls, ['/api/health'], output);
    assert.match(output, /Expected: "(?:local|owned-gate-db)"/);
  });
}
