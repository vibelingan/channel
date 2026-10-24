/** Test-only metadata lifecycle; actual native bytes are verified independently through the compiled worker. */
import assert from 'node:assert/strict';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import type { z } from 'zod';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import type { CatalogImageObservationHealth } from './catalog-image-observation.ts';
import {
  CatalogImageProtectionIntentSchema,
  type CatalogProtectedTargetSchema,
} from './catalog-image-protection-contract.ts';
import type {
  CatalogPreparationJobCommand,
  CatalogPreparationJobResult,
} from './catalog-preparation-jobs.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';
export async function finishOwnedMediaFixture(
  run: (command: CatalogPreparationJobCommand) => Promise<CatalogPreparationJobResult>,
  get: CatalogApprovalTransaction['get'],
  ids: readonly string[],
) {
  const started = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(started.ok && 'progress' in started);
  const jobId = started.progress.jobId;
  const dispatched = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(dispatched.ok && 'call' in dispatched);
  const claimed = await run({
    action: 'claim',
    call: dispatched.call,
    owner: 'unit-reference-worker',
  });
  assert.ok(claimed.ok && 'lease' in claimed);
  const scope = { jobId, lease: claimed.lease };
  const planDigest = 'f'.repeat(64);
  assert.equal(
    (await run({ ...scope, action: 'bind-media-plan', planDigest, total: ids.length })).ok,
    true,
  );
  for (const [index, imageId] of ids.entries()) {
    assert.equal((await run({ ...scope, action: 'reserve-image-check', imageId })).ok, true);
    const original = await get('images', imageId);
    assert.ok(original);
    const begun = await run({
      ...scope,
      action: 'begin-image-protection',
      imageId,
      imageInputDigest: storedCatalogImageInputDigest(original),
    });
    assert.ok(begun.ok && 'protection' in begun, JSON.stringify(begun));
    const intent = CatalogImageProtectionIntentSchema.parse(begun.protection);
    const path = catalogProtectedStoragePath(
      `${intent.imageIdentity}:${intent.checksumSha256}:${intent.attemptId}`,
      'original.png',
    );
    const target: z.infer<typeof CatalogProtectedTargetSchema> = {
      storageProvider: 'local-disk',
      storageMode: 'local-disk',
      storageFileId: `local-disk:${path}`,
      storagePath: path,
      byteSize: 123,
    };
    assert.equal(
      (
        await run({
          ...scope,
          action: 'checkpoint-image-protection',
          imageId,
          intentId: intent._id,
          target,
        })
      ).ok,
      true,
    );
    // Metadata fixture only: actual native PNG verification is covered by compiled-worker integration.
    const health: Extract<CatalogImageObservationHealth, { status: 'verified' }> = {
      status: 'verified',
      kind: 'stored-image-health-v1',
      imageId,
      inputDigest: storedCatalogImageInputDigest({ ...original, ...target }),
      checksumSha256: 'a'.repeat(64),
      byteSize: 123,
      width: 24,
      height: 16,
      pages: 1,
    };
    assert.equal(
      (
        await run({
          ...scope,
          action: 'commit-image-protection',
          imageId,
          intentId: intent._id,
          health,
        })
      ).ok,
      true,
    );
    const image = await get('images', imageId);
    assert.ok(image);
    assert.equal(
      (
        await run({
          ...scope,
          action: 'advance-media-check',
          planDigest,
          index,
          imageId,
          imageInputDigest: storedCatalogImageInputDigest(image),
          health,
        })
      ).ok,
      true,
    );
  }
  assert.equal((await run({ ...scope, action: 'bind-media-seal', planDigest })).ok, true);
  for (const [index, imageId] of ids.entries())
    assert.equal(
      (await run({ ...scope, action: 'attest-media-image', planDigest, index, imageId })).ok,
      true,
    );
  const job = await get('catalogPreparationJobs', jobId);
  assert.ok(
    job && typeof job.inputDigest === 'string' && typeof job.contentGeneration === 'number',
  );
  const done = await run({
    ...scope,
    action: 'finish-preparation',
    inputDigest: job.inputDigest,
    contentGeneration: job.contentGeneration,
    planDigest,
    imageIdsDigest: catalogSealedImageIdsDigest(ids),
    imageCount: ids.length,
    previewReady: true,
    issues: [],
  });
  assert.ok(done.ok && 'report' in done && done.report.state === 'ready', JSON.stringify(done));
  return done.report;
}
