import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import COS from 'cos-nodejs-sdk-v5';
import { blogWorkerSdk } from './blog/worker-source.ts';
import { createRendererSource } from './release/catalog-renderer-source.mjs';
import { packCatalogRenderer } from './release/catalog-renderer.mjs';
import { ARCHIVE_COS_OPTIONS, createCosArchiveTransfer } from './release/cos-archive-transfer.mjs';
import { createGithubReadClient } from './release/github-read.mjs';
import { sha256 } from './release/input.mjs';
import { createPrivateArchive } from './release/private-archive.mjs';
import { requireSiteChecks } from './release/site-checks.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
const env = process.env;
if (
  env.GITHUB_ACTIONS !== 'true' ||
  env.GITHUB_REPOSITORY !== policy.repository ||
  ![policy.trustedRef, 'refs/heads/test'].includes(env.GITHUB_REF ?? '') ||
  env.TCB_ENV_ID !== policy.envId ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !env.GITHUB_TOKEN ||
  !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
)
  throw Error('Approved renderer archive invocation required');
const codeSha = env.SITE_RENDERER_SHA || (env.GITHUB_SHA as string);
if (!/^[a-f0-9]{40}$/.test(codeSha)) throw Error('Exact renderer source commit required');
await requireSiteChecks({
  github: createGithubReadClient({ policy, token: env.GITHUB_TOKEN }),
  policy,
  codeSha: env.GITHUB_SHA,
  context: {
    ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  },
});
if (codeSha !== env.GITHUB_SHA)
  await createGithubReadClient({ policy, token: env.GITHUB_TOKEN }).requireCI(codeSha);
const directory = resolve('output/catalog-renderer');
const manifest = packCatalogRenderer({
  codeSha,
  directory,
  ...(codeSha !== env.GITHUB_SHA
    ? {
        git: (args: string[]) =>
          execFileSync('git', ['-C', 'renderer-source', ...args], { maxBuffer: 256 * 1024 * 1024 }),
      }
    : {}),
});

const config = {
  env: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
};
const sdk = blogWorkerSdk(config);
const manager = new CloudBase({ ...config, envId: policy.envId });
const db = sdk.database();
const archiveCos = new COS({
  SecretId: env.TENCENTCLOUD_SECRETID,
  SecretKey: env.TENCENTCLOUD_SECRETKEY,
  ...ARCHIVE_COS_OPTIONS,
});
const objects = createPrivateArchive({
  ...createCosArchiveTransfer({
    cos: archiveCos,
    policy,
    onStatus: (event: object) =>
      console.log(JSON.stringify({ event: 'private-archive-sdk', ...event })),
  }),
  sdk,
  manager,
  policy,
  readLifecycle: (params: COS.GetBucketLifecycleParams) => archiveCos.getBucketLifecycle(params),
  onTransfer: (event: unknown) =>
    console.log(JSON.stringify({ event: 'private-archive-transfer', ...(event as object) })),
});
const source = createRendererSource({ objects });
const row = db.collection('catalogSeoBuilders').doc(codeSha);
const before = await row.get();
const existing = Array.isArray(before.data) ? before.data[0] : before.data;
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSha256 = sha256(manifestBytes);
let approved = existing;
if (existing) {
  if (
    existing.codeSha !== codeSha ||
    existing.manifestSha256 !== manifestSha256 ||
    existing.archiveSha256 !== manifest.archive.sha256
  )
    throw Error('An existing renderer approval differs; no replacement allowed');
  await source.download(existing);
} else {
  const manifestObject = await objects.put(manifestBytes);
  const archiveObject = await objects.put(await readFile(resolve(directory, 'renderer.tar.gz')));
  approved = {
    schemaVersion: 1,
    codeSha,
    manifestSha256,
    archiveSha256: manifest.archive.sha256,
    manifestObject,
    archiveObject,
    sourceRunId: env.GITHUB_RUN_ID,
    runtime: manifest.runtime,
    inputSchema: 1,
  };
  await source.download(approved);
  await row.set(approved);
}
const after = await row.get();
const verified = Array.isArray(after.data) ? after.data[0] : after.data;
if (
  !verified ||
  verified.manifestSha256 !== manifestSha256 ||
  verified.archiveSha256 !== manifest.archive.sha256 ||
  verified.archiveObject?.fileID !== approved.archiveObject.fileID
)
  throw Error('Renderer approval write needs readback');
await writeFile(
  resolve(directory, 'receipt.json'),
  JSON.stringify({ ...approved, downloadedAndVerified: true, websiteWrites: 0 }, null, 2),
  { flag: 'wx' },
);
console.log(`Renderer ${codeSha} privately archived and read back. Website unchanged.`);
