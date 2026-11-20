import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import {
  assertResponsivePreparationInvocation,
  runCatalogResponsivePreparation,
  selectResponsivePreparationBatch,
} from './prepare-responsive.ts';

assertResponsivePreparationInvocation(process.env);
const env = process.env;
assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
assert.match(env.IMAGE_EXPECTED_PROGRAM ?? '', /^[a-f0-9]{40}$/);
assert(env.GITHUB_TOKEN && env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY);
const selection = selectResponsivePreparationBatch(
  JSON.parse(await readFile(new URL('./responsive-selection.json', import.meta.url), 'utf8')),
  env.IMAGE_RESPONSIVE_BATCH,
);
await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(env.GITHUB_SHA);
await runCatalogResponsivePreparation({
  config: {
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
    ...(env.TENCENTCLOUD_SESSIONTOKEN ? { token: env.TENCENTCLOUD_SESSIONTOKEN } : {}),
  },
  plan: {
    envId: env.TCB_ENV_ID,
    region: env.CLOUDBASE_REGION,
    programSha: env.IMAGE_EXPECTED_PROGRAM,
    ...selection,
  },
  outputDirectory: 'output/responsive-image-preparation',
});
