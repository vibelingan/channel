import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { tsImport } = createRequire(new URL('../apps/site/package.json', import.meta.url))(
  'tsx/esm/api',
);
const {
  ResponsivePreparationPlanSchema,
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
