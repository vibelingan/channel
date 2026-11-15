import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { z } from 'zod';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from '../../packages/db/src/catalog-image-input.ts';
import {
  readCatalogWebImage,
  registerCatalogWebImage,
} from '../../packages/db/src/catalog-web-image.ts';
import type { NodeSdkDatabase } from '../../packages/db/src/cloudbase-adapter.ts';
import { assertDocumentWrite, sdkAnswer } from '../../packages/db/src/cloudbase-sdk-answer.ts';
import { createCloudBaseMediaStorage } from '../../packages/media-storage/src/cloudbase.ts';
import { createCatalogWebImage } from '../../packages/media-storage/src/web-image.ts';
import type { CollectionDoc } from '../../packages/shared/src/index.ts';
import { readFunctionRuntimeVersion } from '../blog/runtime-health.mjs';
import { blogWorkerSdk } from '../blog/worker-source.ts';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { replaceFunctionCode } from '../release/function-replacement.mjs';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { fetchFully } from '../smoke-http.mjs';

const env = process.env;
const envId = 'diversity-123-d9grnqfux221323bb';
const region = 'ap-shanghai';
assert(
  env.GITHUB_ACTIONS === 'true' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === 'vibelingan/channel' &&
    env.GITHUB_REF === 'refs/heads/feat/seo-foundation' &&
    env.TCB_ENV_ID === envId &&
    env.IMAGE_DELIVERY_CONFIRM === 'PREPARE_WEB_IMAGES_AND_PUBLIC_API_ONLY',
  'Untrusted image repair invocation',
);
const sourceSha = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .parse(env.GITHUB_SHA);
assert(
  /^[a-f0-9]{64}$/.test(env.IMAGE_EXPECTED_PACKAGE ?? '') &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''),
);
assert(env.GITHUB_TOKEN && env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY);
await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(env.GITHUB_SHA);
const plan = z
  .object({
    schemaVersion: z.literal(1),
    envId: z.literal(envId),
    targets: z
      .array(
        z
          .object({
            imageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
            checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
            byteSize: z.number().int().min(4_400_000).max(10_485_760),
          })
          .strict(),
      )
      .length(19),
  })
  .strict()
  .parse(JSON.parse(await readFile('scripts/images/repair-20261116.json', 'utf8')));
assert(
  plan.envId === envId &&
    plan.targets.length === 19 &&
    new Set(plan.targets.map((x: { imageId: string }) => x.imageId)).size === 19,
  'Unreviewed repair scope',
);
const manager = new CloudBase({
  envId,
  region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const sdk = blogWorkerSdk({
  env: envId,
  region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const db: NodeSdkDatabase = sdk.database();
const media = createCloudBaseMediaStorage(sdk);
const provider = createCloudbaseFunctionProvider({
  manager,
  target: { envId, siteOrigin: 'https://supplychainsai.com' },
  region,
  names: ['public-api'],
  configurationKey: undefined,
});
const before = await provider.capture('public-api');
assert.equal(
  before.snapshot.packageSha256,
  env.IMAGE_EXPECTED_PACKAGE,
  'Public API differs from the observed package',
);
assert.equal(before.snapshot.runtime, 'Nodejs20.19');
assert.equal(before.snapshot.handler, 'index.main');
const beforeVersion = await readFunctionRuntimeVersion(envId, 'public-api');
const manifest = JSON.parse(await readFile('output/image-delivery-package/manifest.json', 'utf8'));
const candidate = await readFile('output/image-delivery-package/function.zip');
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
assert.equal(manifest.codeSha, env.GITHUB_SHA);
assert.equal(manifest.functionName, 'public-api');
assert.equal(manifest.sha256, hash(candidate));
function document(answer: unknown, id: string): CollectionDoc {
  const v = sdkAnswer(answer);
  assert(v && typeof v === 'object');
  let data = Reflect.get(v, 'data');
  if (Array.isArray(data)) {
    assert.equal(data.length, 1);
    data = data[0];
  }
  const row = z
    .object({ _id: z.literal(id) })
    .passthrough()
    .parse(data);
  return row;
}
const sources: CollectionDoc[] = [];
for (const target of plan.targets) {
  const row = document(await db.collection('images').doc(target.imageId).get(), target.imageId);
  assert(
    isStoredCatalogImageRecord(row, row._id) && row.storageProvider === 'cloudbase-storage',
    'Image is not a verified stored source',
  );
  assert.equal(row.checksumSha256, target.checksumSha256);
  assert.equal(row.byteSize, target.byteSize);
  sources.push(row);
}
const root = 'output/image-delivery-live';
await mkdir(root, { recursive: true });
for (const [name, body] of [
  ['before.zip', before.bytes],
  ['candidate.zip', candidate],
  ['images-before.json', JSON.stringify(sources, null, 2)],
  [
    'scope.json',
    JSON.stringify(
      {
        source: env.GITHUB_SHA,
        functionName: 'public-api',
        before: before.snapshot,
        beforeVersion,
        originalsChanged: false,
        productContentChanged: false,
        permissionChanged: false,
      },
      null,
      2,
    ),
  ],
] as const)
  await writeFile(`${root}/${name}`, body, { flag: 'wx' });
const archive = await new DefaultArtifactClient().uploadArtifact(
  `image-delivery-before-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  ['before.zip', 'candidate.zip', 'images-before.json', 'scope.json'].map((x) => `${root}/${x}`),
  root,
  { retentionDays: 90 },
);
assert(archive.id && archive.digest, 'Original program and image mappings were not archived');
const result: {
  stage: string;
  archiveId: number;
  source: string;
  images: object[];
  program?: unknown;
  status?: string;
} = { stage: 'prepare-images', archiveId: archive.id, source: sourceSha, images: [] };
const save = () => writeFile(`${root}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
await save();
try {
  for (const row of sources) {
    const existing = readCatalogWebImage(row);
    if (existing) {
      const stored = Buffer.from(
        (
          await media.getObjectAsBase64(existing.storageFileId, {
            maxBytes: existing.byteSize,
            timeoutMs: 30000,
          })
        ).body,
        'base64',
      );
      assert.equal(stored.byteLength, existing.byteSize);
      assert.equal(hash(stored), existing.checksumSha256);
      result.images.push({ imageId: row._id, status: 'reused', bytes: existing.byteSize });
      await save();
      continue;
    }
    assert(isStoredCatalogImageRecord(row, row._id));
    const source = Buffer.from(
      (
        await media.getObjectAsBase64(row.storageFileId, {
          maxBytes: row.byteSize,
          timeoutMs: 30000,
        })
      ).body,
      'base64',
    );
    assert.equal(source.byteLength, row.byteSize);
    assert.equal(hash(source), row.checksumSha256);
    const web = await createCatalogWebImage(source, row.mimeType);
    const target = await media.putObject({
      namespace: 'catalog-web',
      logicalId: hash(Buffer.from(row._id)),
      fileName: `${row.checksumSha256}-${web.checksumSha256}.webp`,
      mimeType: web.mimeType,
      content: web.bytes,
    });
    const confirmed = Buffer.from(
      (
        await media.getObjectAsBase64(target.storageFileId, {
          maxBytes: web.byteSize,
          timeoutMs: 30000,
        })
      ).body,
      'base64',
    );
    assert.equal(confirmed.byteLength, web.byteSize);
    assert.equal(hash(confirmed), web.checksumSha256);
    const descriptor = {
      schemaVersion: 1,
      sourceDigest: storedCatalogImageInputDigest(row),
      storageProvider: target.storageProvider,
      storageFileId: target.storageFileId,
      storagePath: target.storagePath,
      mimeType: web.mimeType,
      byteSize: web.byteSize,
      width: web.width,
      height: web.height,
      checksumSha256: web.checksumSha256,
    };
    const status = await db.runTransaction((tx) =>
      registerCatalogWebImage(
        {
          get: async (collection, id) =>
            document(await tx.collection(collection).doc(id).get(), id),
          set: async (collection, next) => {
            const { _id, ...data } = next;
            assertDocumentWrite(await tx.collection(collection).doc(_id).set(data), _id, 'set');
          },
        },
        row._id,
        descriptor,
      ),
    );
    result.images.push({
      imageId: row._id,
      status,
      sourceBytes: row.byteSize,
      bytes: web.byteSize,
      width: web.width,
      height: web.height,
    });
    await save();
  }
  result.stage = 'update-public-api';
  await save();
  result.program = await replaceFunctionCode({
    name: 'public-api',
    provider,
    before: before.snapshot,
    original: before.bytes,
    candidate,
    beforeVersion,
    expectedVersion: env.GITHUB_SHA,
    readHealth: () => readFunctionRuntimeVersion(envId, 'public-api'),
  });
  assert.equal(
    Reflect.get(Object(result.program), 'status'),
    'accepted',
    'Public API activation was not accepted',
  );
  result.stage = 'verify-five-google-errors';
  await save();
  for (const id of [
    '3fbe8b166ac87f63003984d22ff5a5d7',
    '66baec6f6ac882aa00729f35667d3ea5',
    '4db8df016ac88396000781db489eb227',
    'ea7765a56ab1dbea01d9b6924386c973',
    '31051309-b170-4ef2-a7f7-86c645fd3fad',
  ]) {
    const response = await fetchFully('GET', `https://supplychainsai.com/api/images/${id}`, {
      timeoutMs: 30000,
      maxBytes: 3_100_000,
      redirect: 'error',
    });
    assert.equal(response.status, 200, 'A Google image URL is still unavailable');
    assert.equal(response.headers.get('content-type')?.split(';')[0], 'image/webp');
  }
  result.stage = 'complete';
  result.status = 'passed';
  await save();
} catch (error) {
  result.status = 'stopped';
  await save();
  throw error;
}
