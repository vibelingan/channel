import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { tsImport } = createRequire(new URL('../apps/site/package.json', import.meta.url))(
  'tsx/esm/api',
);
const {
  ResponsivePreparationPlanSchema,
  selectResponsivePreparationBatch,
  runCatalogResponsivePreparation,
  assertResponsivePreparationInvocation,
} = await tsImport('./images/prepare-responsive.ts', import.meta.url);
const plan = {
  envId: 'diversity-123-d9grnqfux221323bb',
  region: 'ap-shanghai',
  programSha: 'a'.repeat(40),
  images: [
    {
      imageId: 'selected-image',
      sourceDigest: 'b'.repeat(64),
      sourceSha256: 'c'.repeat(64),
      defaultSha256: 'd'.repeat(64),
    },
  ],
};
test('only the existing manual workflow holding the shared deployment queue may run preparation', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vibelingan/channel',
    GITHUB_REF: 'refs/heads/feat/seo-foundation',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF:
      'vibelingan/channel/.github/workflows/seo-static-canary.yml@refs/heads/feat/seo-foundation',
    TCB_ENV_ID: plan.envId,
    CLOUDBASE_REGION: plan.region,
  };
  assert.doesNotThrow(() => assertResponsivePreparationInvocation(env));
  for (const key of Object.keys(env))
    assert.throws(
      () => assertResponsivePreparationInvocation({ ...env, [key]: 'wrong' }),
      /serialized manual workflow/,
    );
});
test('responsive preparation accepts only an explicit bounded and unique environment-specific scope', () => {
  assert.deepEqual(ResponsivePreparationPlanSchema.parse(plan), plan);
  for (const patch of [
    { envId: 'another-environment' },
    { region: 'us-east' },
    { images: [] },
    { images: [...plan.images, ...plan.images] },
    { programSha: 'latest' },
    { images: [{ ...plan.images[0], sourceDigest: undefined }] },
    {
      images: Array.from({ length: 21 }, (_, i) => ({ ...plan.images[0], imageId: `image-${i}` })),
    },
  ])
    assert.equal(ResponsivePreparationPlanSchema.safeParse({ ...plan, ...patch }).success, false);
});
test('an exact batch selects at most twenty reviewed images and legacy selections still work', () => {
  const selected = { publicApiProgramSha: 'e'.repeat(40), images: plan.images };
  const second = [{ ...plan.images[0], imageId: 'second-image' }];
  const manifest = {
    publicApiProgramSha: selected.publicApiProgramSha,
    batches: [plan.images, second],
  };
  assert.deepEqual(selectResponsivePreparationBatch(selected), selected);
  assert.throws(() => selectResponsivePreparationBatch(selected, '1'), /single batch/);
  assert.deepEqual(selectResponsivePreparationBatch(manifest, '1'), selected);
  assert.deepEqual(selectResponsivePreparationBatch(manifest, '2'), {
    ...selected,
    images: second,
  });
  for (const index of ['', '0', '02', '3', '2.0']) {
    assert.throws(() => selectResponsivePreparationBatch(manifest, index), /Choose an existing/);
  }
  for (const batches of [
    [plan.images, plan.images],
    [plan.images, []],
    [plan.images, Array(21).fill(second[0])],
  ]) {
    assert.throws(() => selectResponsivePreparationBatch({ ...manifest, batches }, '1'));
  }
});
test('the operator cannot reach a cloud call or create output before confirmation and config validation', async () => {
  const previous = process.env.CATALOG_RESPONSIVE_CONFIRM;
  const config = { secretId: 'fixture', secretKey: 'not-live' };
  const input = { config, plan, outputDirectory: 'output/must-not-create-responsive' };
  try {
    process.env.CATALOG_RESPONSIVE_CONFIRM = 'not-confirmed';
    await assert.rejects(runCatalogResponsivePreparation(input), /confirmation/);
    process.env.CATALOG_RESPONSIVE_CONFIRM = 'PREPARE_SELECTED_SIZES_ONLY';
    await assert.rejects(
      runCatalogResponsivePreparation({ ...input, config: { ...config, envId: 'other' } }),
    );
    await assert.rejects(
      runCatalogResponsivePreparation({ ...input, outputDirectory: '' }),
      /directory/,
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'CATALOG_RESPONSIVE_CONFIRM');
    else process.env.CATALOG_RESPONSIVE_CONFIRM = previous;
  }
});

test('a clean checkout creates private output parents and an existing result is never overwritten', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-responsive-clean-'));
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vibelingan/channel',
    GITHUB_REF: 'refs/heads/feat/seo-foundation',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF:
      'vibelingan/channel/.github/workflows/seo-static-canary.yml@refs/heads/feat/seo-foundation',
    TCB_ENV_ID: plan.envId,
    CLOUDBASE_REGION: plan.region,
    CATALOG_RESPONSIVE_CONFIRM: 'PREPARE_SELECTED_SIZES_ONLY',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    throw Error('controlled-stop-before-cloud-identity');
  });
  const outputDirectory = join(root, 'clean-checkout', 'output', 'result');
  const input = { config: { secretId: 'fixture', secretKey: 'not-live' }, plan, outputDirectory };
  try {
    Object.assign(process.env, env);
    await assert.rejects(
      runCatalogResponsivePreparation(input),
      /controlled-stop-before-cloud-identity/,
    );
    assert.deepEqual(calls, [`https://${plan.envId}.service.tcloudbase.com/api/admin`]);
    const scope = await readFile(join(outputDirectory, 'scope.private.json'), 'utf8');
    assert.deepEqual(JSON.parse(scope).plan, plan);
    for (const path of [join(root, 'clean-checkout', 'output'), outputDirectory])
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    await assert.rejects(runCatalogResponsivePreparation(input), { code: 'EEXIST' });
    assert.equal(calls.length, 1, 'Existing output must stop before another cloud request');
    assert.equal(await readFile(join(outputDirectory, 'scope.private.json'), 'utf8'), scope);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
