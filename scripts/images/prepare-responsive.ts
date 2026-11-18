import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { CatalogApprovalTransaction } from '../../packages/db/src/catalog-detail-commit.ts';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from '../../packages/db/src/catalog-image-input.ts';
import {
  type CatalogWebBackfillCommand,
  runCatalogWebBackfill,
} from '../../packages/db/src/catalog-web-backfill.ts';
import {
  bindCatalogWebImage,
  bindCatalogWebVariants,
  readCatalogWebImage,
  readCatalogWebVariants,
} from '../../packages/db/src/catalog-web-image.ts';
import {
  type NodeSdkDatabase,
  acquireImageMutationInCloudBase,
  releaseImageMutationInCloudBase,
} from '../../packages/db/src/cloudbase-adapter.ts';
import { assertDocumentWrite, sdkAnswer } from '../../packages/db/src/cloudbase-sdk-answer.ts';
import {
  imageUploadInputDigest,
  readImageUploadWebPreparation,
} from '../../packages/db/src/image-upload.ts';
import { prepareCatalogWebVariants } from '../../packages/media-storage/src/catalog-web-prepare.ts';
import { createCloudBaseMediaStorage } from '../../packages/media-storage/src/cloudbase.ts';
import type { CollectionDoc } from '../../packages/shared/src/index.ts';
import { readFunctionRuntimeVersion } from '../blog/runtime-health.mjs';
import { blogWorkerSdk } from '../blog/worker-source.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export function assertResponsivePreparationInvocation(env: NodeJS.ProcessEnv) {
  assert(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === 'vibelingan/channel' &&
      env.GITHUB_REF === 'refs/heads/feat/seo-foundation' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_WORKFLOW_REF ===
        'vibelingan/channel/.github/workflows/seo-static-canary.yml@refs/heads/feat/seo-foundation' &&
      env.TCB_ENV_ID === 'diversity-123-d9grnqfux221323bb' &&
      env.CLOUDBASE_REGION === 'ap-shanghai',
    'Responsive preparation requires the existing serialized manual workflow',
  );
}
export const ResponsivePreparationPlanSchema = z
  .object({
    envId: z.literal('diversity-123-d9grnqfux221323bb'),
    region: z.literal('ap-shanghai'),
    programSha: z.string().regex(/^[a-f0-9]{40}$/),
    images: z
      .array(
        z
          .object({
            imageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
            sourceDigest: sha,
            sourceSha256: sha,
            defaultSha256: sha,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine((plan) => new Set(plan.images.map((item) => item.imageId)).size === plan.images.length);

function document(answer: unknown, id: string): CollectionDoc {
  const result = sdkAnswer(answer);
  assert(result && typeof result === 'object');
  const data = Reflect.get(result, 'data');
  if (Array.isArray(data)) {
    assert.equal(data.length, 1, 'Exactly one selected image is required');
    return z
      .object({ _id: z.literal(id) })
      .passthrough()
      .parse(data[0]);
  }
  return z
    .object({ _id: z.literal(id) })
    .passthrough()
    .parse(data);
}

/** Explicit operator entry; never starts from a page request, timer, or unbounded collection scan. */
export async function runCatalogResponsivePreparation(input: {
  config: { secretId: string; secretKey: string; token?: string; envId?: string; region?: string };
  plan: unknown;
  outputDirectory: string;
}) {
  const plan = ResponsivePreparationPlanSchema.parse(input.plan);
  const config = z
    .object({
      secretId: z.string().min(1),
      secretKey: z.string().min(1),
      token: z.string().min(1).optional(),
      envId: z.literal(plan.envId).optional(),
      region: z.literal(plan.region).optional(),
    })
    .strict()
    .parse(input.config);
  assert(
    process.env.CATALOG_RESPONSIVE_CONFIRM === 'PREPARE_SELECTED_SIZES_ONLY',
    'Explicit selected-size confirmation required',
  );
  assert(input.outputDirectory.trim(), 'Private output directory required');
  assertResponsivePreparationInvocation(process.env);
  const directory = resolve(input.outputDirectory);
  await mkdir(directory, { mode: 0o700 });
  const save = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await save('scope.private.json', {
    plan,
    originalWrites: 0,
    productWrites: 0,
    publicationWrites: 0,
    deletes: 0,
  });
  // All three writers must understand pending sizes and their cleanup before adding targets.
  for (const name of ['admin', 'public-api', 'alibaba-catalog-sync'])
    assert.equal(
      await readFunctionRuntimeVersion(plan.envId, name),
      plan.programSha,
      `${name} is not the reviewed compatible program`,
    );
  const sdk = blogWorkerSdk({
    env: plan.envId,
    region: plan.region,
    secretId: config.secretId,
    secretKey: config.secretKey,
    ...(config.token ? { sessionToken: config.token } : {}),
  });
  const db: NodeSdkDatabase = sdk.database();
  const storage = createCloudBaseMediaStorage(sdk);
  const results = [];
  for (const target of plan.images) {
    const owner = randomUUID();
    let owned = false;
    const get = () =>
      db.runTransaction(async (tx) =>
        document(await tx.collection('images').doc(target.imageId).get(), target.imageId),
      );
    try {
      // An unknown acquisition result is read back, never followed by a second acquisition.
      try {
        owned =
          (await acquireImageMutationInCloudBase(
            db,
            target.imageId,
            owner,
            new Date().toISOString(),
          )) === 'acquired';
      } catch {
        owned = (await get()).imageMutationOwner === owner;
      }
      assert(owned, 'Selected image is busy or missing');
      const source = await get();
      assert(
        isStoredCatalogImageRecord(source, target.imageId),
        'Selected source is no longer active',
      );
      assert.equal(source.storageProvider, 'cloudbase-storage');
      assert.equal(
        storedCatalogImageInputDigest(source),
        target.sourceDigest,
        'Selected original binding changed',
      );
      assert.equal(source.checksumSha256, target.sourceSha256);
      const base = readCatalogWebImage(source);
      assert(
        base && base.checksumSha256 === target.defaultSha256,
        'Selected default image changed',
      );
      const saved = readImageUploadWebPreparation(source);
      assert(
        !Object.hasOwn(source, 'imageWebPreparation') ||
          (saved && saved.inputDigest === imageUploadInputDigest(source)),
        'Foreign preparation must be preserved',
      );
      if (saved) assert.deepEqual(saved.catalogWebImage, base, 'Pending default differs');
      const activeVariants = readCatalogWebVariants(source);
      assert(
        !Object.hasOwn(source, 'catalogWebVariants') || activeVariants,
        'Unknown sizes must be preserved',
      );
      await save(`${source._id}.before.private.json`, source);
      const bytes = Buffer.from(
        (
          await storage.getObjectAsBase64(source.storageFileId, {
            maxBytes: source.byteSize,
            timeoutMs: 30_000,
          })
        ).body,
        'base64',
      );
      assert.equal(bytes.length, source.byteSize);
      assert.equal(hash(bytes), target.sourceSha256);
      const persist = (command: CatalogWebBackfillCommand) =>
        db.runTransaction(async (tx) => {
          const store: CatalogApprovalTransaction = {
            get: async (_collection, id) =>
              document(await tx.collection('images').doc(id).get(), id),
            set: async (_collection, row) => {
              const { _id, ...fields } = row;
              assertDocumentWrite(await tx.collection('images').doc(_id).set(fields), _id, 'set');
            },
          };
          return runCatalogWebBackfill(store, command);
        });
      const command = {
        imageId: source._id,
        owner,
        sourceDigest: target.sourceDigest,
        catalogWebImage: base,
      };
      const prepared = await prepareCatalogWebVariants({
        imageId: source._id,
        bytes,
        mimeType: source.mimeType,
        checksumSha256: target.sourceSha256,
        storage,
        existing: {
          default: saved?.catalogWebImage ?? base,
          variants: saved?.catalogWebVariants ?? activeVariants ?? {},
        },
        checkpoint: async (value) =>
          assert.equal(
            await persist({
              ...command,
              action: 'checkpoint',
              catalogWebImage: bindCatalogWebImage(source, value.default),
              catalogWebVariants: bindCatalogWebVariants(source, value.variants),
            }),
            'checkpointed',
          ),
      });
      assert(prepared, 'Existing default must be retained');
      const catalogWebVariants = bindCatalogWebVariants(source, prepared.variants);
      // Also checkpoint when a narrow image needs no separate file.
      assert.equal(
        await persist({ ...command, action: 'checkpoint', catalogWebVariants }),
        'checkpointed',
      );
      assert.equal(await persist({ ...command, action: 'complete', catalogWebVariants }), 'ready');
      const after = await get();
      assert.equal(storedCatalogImageInputDigest(after), target.sourceDigest);
      assert.deepEqual(readCatalogWebVariants(after), catalogWebVariants);
      await save(`${source._id}.after.private.json`, after);
      results.push({
        imageId: source._id,
        status: 'ready',
        widths: Object.values(catalogWebVariants).flatMap((value) => (value ? [value.width] : [])),
      });
    } finally {
      if (owned)
        assert.equal(
          await releaseImageMutationInCloudBase(db, target.imageId, owner),
          'released',
          'Image lock release must be confirmed',
        );
    }
  }
  await save('result.private.json', results);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { readFile } = await import('node:fs/promises');
  const [configFile, planFile, outputDirectory] = process.argv.slice(2);
  assert(
    configFile && planFile && outputDirectory,
    'Usage: prepare-responsive.ts private-config.json plan.json new-output-directory',
  );
  await runCatalogResponsivePreparation({
    config: JSON.parse(await readFile(configFile, 'utf8')),
    plan: JSON.parse(await readFile(planFile, 'utf8')),
    outputDirectory,
  });
}
