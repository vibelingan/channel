import { randomUUID } from 'node:crypto';
import {
  type SourceMediaImportCommand,
  type SourceMediaImportResult,
  get,
  manageCatalogPreparationJob,
} from '@vibelingan-channel/db';
import { readImageMutationState } from '@vibelingan-channel/db/adapter';
import { storedCatalogImageInputDigest } from '@vibelingan-channel/db/catalog-image-input';
import {
  CATALOG_MEDIA_ATTESTATION_PAGE_SIZE,
  type CatalogPreparationAuthority,
  type CatalogPreparationJobResult,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import {
  catalogPreparationPlanDigest,
  catalogSealedImageIdsDigest,
} from '@vibelingan-channel/db/catalog-preparation-media-seal';
import { alibabaPhotoSource } from '@vibelingan-channel/shared';
import type { CatalogIssue } from '@vibelingan-channel/shared/catalog-issues';
import { CatalogPreparationReportSchema } from '@vibelingan-channel/shared/catalog-preparation';
import type { readStoredCatalogImageHealth } from './catalog-image-health.ts';
import { prepareStoredCatalogImage } from './catalog-image-protection.ts';
import { inspectCatalogPreparationJob } from './catalog-preparation-job-inspect.ts';
export type CatalogSourceImageImporter = (
  sourceUrl: string,
  persist: (command: SourceMediaImportCommand) => Promise<SourceMediaImportResult>,
) => Promise<{ ok: boolean }>;
type Media = Readonly<{
  total: number;
  checked: number;
  verified: number;
  invalid: number;
  retry: number;
}>;
type WorkerResult =
  | { ok: false; code: Extract<CatalogPreparationJobResult, { ok: false }>['code'] | 'UNAVAILABLE' }
  | {
      ok: true;
      kind: 'unsealed-worker-step' | 'catalog-preparation-step';
      outcome: 'partial' | 'checked' | 'blocked' | 'retryable' | 'ready';
      attestation?: Readonly<{ total: number; checked: number }>;
      jobId: string;
      productId: string;
      media: Media;
      issues: readonly CatalogIssue[];
    };
const candidatePlanDigest = catalogPreparationPlanDigest;
const maxImages = 4;
// Protected receipts use metadata; downloads and fresh pixel work keep their four-image cap.
const maxProtectedImages = 16;
const tailBudgetMs = 8000;
type WorkerOptions = {
  now?: () => number;
  budgetMs?: number;
  checkImage?: typeof readStoredCatalogImageHealth;
  importSourceImage?: CatalogSourceImageImporter;
};
/** Signed default consumer: media, bounded attestation, then atomic current readiness. */
export function runCatalogPreparationWorker(
  authority: CatalogPreparationAuthority,
  call: unknown,
  options: WorkerOptions = {},
): Promise<WorkerResult> {
  return runCatalogPreparationStages(authority, call, options, true);
}
/** Media subflow: preserve a resumable checked cursor without granting product readiness. */
export function runCatalogPreparationMediaWorker(
  authority: CatalogPreparationAuthority,
  call: unknown,
  options: WorkerOptions = {},
): Promise<WorkerResult> {
  return runCatalogPreparationStages(authority, call, options, false);
}
async function runCatalogPreparationStages(
  authority: CatalogPreparationAuthority,
  call: unknown,
  options: WorkerOptions,
  ready: boolean,
): Promise<WorkerResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budget = options.budgetMs ?? 20000;
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isFinite(budget) || budget <= 0)
    throw Error('Invalid preparation worker clock or budget');
  if (!authority.verifyCall(call)) return { ok: false, code: 'FORBIDDEN' };
  let claimed: CatalogPreparationJobResult;
  try {
    claimed = await manageCatalogPreparationJob(authority, {
      action: 'claim',
      call,
      owner: randomUUID(),
    });
  } catch {
    return { ok: false, code: 'UNAVAILABLE' };
  }
  if (!claimed.ok) return { ok: false, code: claimed.code };
  if ('preparation' in claimed) {
    const report = claimed.report;
    if (!ready || report.state !== 'ready') return { ok: false, code: 'CONFLICT' };
    const total = report.seal.imageCount;
    return {
      ok: true,
      kind: 'catalog-preparation-step',
      outcome: 'ready',
      jobId: report.seal.jobId,
      productId: claimed.productId,
      media: { total, checked: total, verified: total, invalid: 0, retry: 0 },
      attestation: { total, checked: total },
      issues: report.issues,
    };
  }
  if (!('lease' in claimed)) return { ok: false, code: 'CONFLICT' };
  const { lease, progress } = claimed;
  const run = (command: Parameters<typeof manageCatalogPreparationJob>[1]) =>
    manageCatalogPreparationJob(authority, command);
  async function finishMedia(checked: Extract<WorkerResult, { ok: true }>): Promise<WorkerResult> {
    let partial = { ...checked, outcome: 'partial' as const };
    if (now() - startedAt >= budget - tailBudgetMs) return partial;
    const candidate = await inspectCatalogPreparationJob(authority, progress.jobId, lease, {
      mediaMode: 'defer',
    });
    if (!candidate.ok) return { ok: false, code: candidate.code };
    if (
      !candidate.previewReady ||
      candidate.issues.some((i) => i.severity === 'error') ||
      candidate.sourcePhotos.some((p) => p.imageId === null)
    )
      return { ok: false, code: 'CONFLICT' };
    const planDigest = candidatePlanDigest(candidate);
    const bound = await run({
      action: 'bind-media-seal',
      jobId: progress.jobId,
      lease,
      planDigest,
    });
    if (!bound.ok) return { ok: false, code: bound.code };
    if (!('mediaSeal' in bound)) return { ok: false, code: 'CONFLICT' };
    let seal = bound.mediaSeal;
    for (let checked = 0; checked < maxProtectedImages && seal.cursor < seal.total; ) {
      if (now() - startedAt >= budget - tailBudgetMs) break;
      const count = Math.min(
        CATALOG_MEDIA_ATTESTATION_PAGE_SIZE,
        maxProtectedImages - checked,
        seal.total - seal.cursor,
      );
      const imageIds = candidate.imageIds.slice(seal.cursor, seal.cursor + count);
      if (imageIds.length !== count) return { ok: false, code: 'CORRUPT' };
      const from = seal;
      const attested = await run(
        imageIds.length === 1
          ? {
              action: 'attest-media-image',
              jobId: progress.jobId,
              lease,
              planDigest,
              index: seal.cursor,
              imageId: imageIds[0] ?? '',
            }
          : {
              action: 'attest-media-page',
              jobId: progress.jobId,
              lease,
              planDigest,
              from,
              imageIds,
            },
      );
      if (!attested.ok) return { ok: false, code: attested.code };
      if (!('mediaSeal' in attested) || attested.mediaSeal.cursor !== from.cursor + count)
        return { ok: false, code: 'CONFLICT' };
      seal = attested.mediaSeal;
      checked += count;
    }
    partial = { ...partial, attestation: { total: seal.total, checked: seal.cursor } };
    if (seal.cursor !== seal.total || now() - startedAt >= budget - tailBudgetMs) return partial;
    const current = await inspectCatalogPreparationJob(authority, progress.jobId, lease, {
      mediaMode: 'defer',
    });
    if (!current.ok) return { ok: false, code: current.code };
    if (
      !current.previewReady ||
      current.issues.some((i) => i.severity === 'error') ||
      current.sourcePhotos.some((p) => p.imageId === null) ||
      candidatePlanDigest(current) !== planDigest
    )
      return { ok: false, code: 'CONFLICT' };
    const command = {
      action: 'finish-preparation' as const,
      jobId: progress.jobId,
      lease,
      inputDigest: current.inputDigest,
      contentGeneration: current.contentGeneration,
      planDigest,
      imageIdsDigest: catalogSealedImageIdsDigest(current.imageIds),
      imageCount: current.imageIds.length,
      previewReady: true as const,
      issues: current.issues,
    };
    let finished: CatalogPreparationJobResult;
    try {
      finished = await run(command);
    } catch {
      finished = await run(command);
    }
    if (!finished.ok) return { ok: false, code: finished.code };
    if (!('preparation' in finished)) return { ok: false, code: 'CONFLICT' };
    return { ...partial, outcome: 'ready', issues: finished.report.issues };
  }
  async function checkpointStep(
    step: Extract<WorkerResult, { ok: true }>,
    previewReady: boolean,
  ): Promise<WorkerResult> {
    const command = {
      action: 'checkpoint-preparation' as const,
      jobId: progress.jobId,
      lease,
      previewReady,
      issues: [...step.issues],
    };
    let saved: CatalogPreparationJobResult;
    try {
      saved = await run(command);
    } catch {
      saved = await run(command);
    }
    if (!saved.ok) return { ok: false, code: saved.code };
    if (!('report' in saved) || saved.report.state === 'ready')
      return { ok: false, code: 'CONFLICT' };
    return {
      ...step,
      issues: saved.report.issues,
      outcome:
        saved.report.state === 'blocked'
          ? 'blocked'
          : step.media.retry > 0
            ? 'retryable'
            : step.outcome === 'checked'
              ? 'partial'
              : step.outcome,
    };
  }
  async function work(): Promise<WorkerResult> {
    let candidate = await inspectCatalogPreparationJob(authority, progress.jobId, lease, {
      mediaMode: 'defer',
    });
    if (!candidate.ok) return { ok: false, code: candidate.code };
    const importer = options.importSourceImage;
    async function importPhoto(sourceUrl: string) {
      if (!importer) throw Error('Source importer unavailable');
      const renewed = await run({ action: 'renew', jobId: progress.jobId, lease });
      if (!renewed.ok) throw Error('Source import lease changed');
      const normalized = alibabaPhotoSource(sourceUrl);
      if (!normalized) throw Error('Source import URL invalid');
      return importer(normalized, async (command) => {
        if (command.action === 'retire' || command.sourceUrl !== normalized)
          throw Error('Source import scope changed');
        const saved = await run({
          action: 'manage-source-media',
          jobId: progress.jobId,
          lease,
          command,
        });
        if (!saved.ok || !('sourceMedia' in saved)) throw Error('Source import was not confirmed');
        return saved.sourceMedia;
      });
    }
    const pending = candidate.sourcePhotos.filter((photo) => photo.imageId === null);
    let sourceFailed = false;
    if (
      pending.length &&
      candidate.previewReady &&
      !candidate.issues.some((i) => i.severity === 'error')
    ) {
      if (!importer) return { ok: false, code: 'UNAVAILABLE' };
      for (const photo of pending.slice(0, maxImages)) {
        if (now() - startedAt >= budget - tailBudgetMs) break;
        const imported = await importPhoto(photo.sourceUrl);
        sourceFailed ||= !imported.ok;
      }
      candidate = await inspectCatalogPreparationJob(authority, progress.jobId, lease, {
        mediaMode: 'defer',
      });
      if (!candidate.ok) return { ok: false, code: candidate.code };
    }
    if (candidate.sourcePhotos.some((photo) => photo.imageId === null)) {
      const step: Extract<WorkerResult, { ok: true }> = {
        ok: true,
        kind: 'unsealed-worker-step',
        jobId: progress.jobId,
        productId: progress.productId,
        media: { total: candidate.imageIds.length, checked: 0, verified: 0, invalid: 0, retry: 0 },
        issues: candidate.issues,
        outcome: candidate.issues.some((i) => i.severity === 'error')
          ? 'blocked'
          : sourceFailed
            ? 'retryable'
            : 'partial',
      };
      return ready ? checkpointStep(step, candidate.previewReady) : step;
    }
    const planDigest = candidatePlanDigest(candidate);
    let inspection = candidate;
    // Historical data selects an optimization only; every current guard still runs.
    if (
      ready &&
      !options.checkImage &&
      candidate.previewReady &&
      !candidate.issues.some((issue) => issue.severity === 'error') &&
      candidate.imageIds.length >= 2 &&
      candidate.imageIds.length <= 12 &&
      (progress.media?.checked ?? 0) === 0 &&
      !candidate.sourcePhotos.some((photo) => photo.imageId === null)
    ) {
      const product = await get('products', progress.productId);
      const prior = CatalogPreparationReportSchema.safeParse(product?.catalogPreparationReport);
      if (
        prior.success &&
        prior.data.state === 'ready' &&
        prior.data.productId === progress.productId &&
        prior.data.seal.imageCount === candidate.imageIds.length &&
        prior.data.seal.imageIdsDigest === catalogSealedImageIdsDigest(candidate.imageIds)
      ) {
        let retained = true;
        for (let index = 0; index < candidate.imageIds.length; index += 8) {
          if (now() - startedAt >= budget - tailBudgetMs) {
            retained = false;
            break;
          }
          const result = await run({
            action: 'reserve-image-page',
            jobId: progress.jobId,
            lease,
            imageIds: candidate.imageIds.slice(index, index + 8),
          });
          if (!result.ok) return { ok: false, code: result.code };
          if (!('reservation' in result)) {
            retained = false;
            break;
          }
        }
        if (retained && now() - startedAt < budget - tailBudgetMs) {
          const command = {
            action: 'finish-protected-preparation' as const,
            jobId: progress.jobId,
            lease,
            inputDigest: candidate.inputDigest,
            contentGeneration: candidate.contentGeneration,
            planDigest,
            imageIdsDigest: catalogSealedImageIdsDigest(candidate.imageIds),
            imageCount: candidate.imageIds.length,
            imageIds: [...candidate.imageIds],
            previewReady: true as const,
            issues: candidate.issues,
          };
          let result: Awaited<ReturnType<typeof run>>;
          try {
            result = await run(command);
          } catch {
            result = await run(command);
          }
          if (!result.ok) return { ok: false, code: result.code };
          if ('preparation' in result && result.report.state === 'ready') {
            const total = candidate.imageIds.length;
            return {
              ok: true,
              kind: 'catalog-preparation-step',
              outcome: 'ready',
              jobId: progress.jobId,
              productId: progress.productId,
              media: { total, checked: total, verified: total, invalid: 0, retry: 0 },
              attestation: { total, checked: total },
              issues: result.report.issues,
            };
          }
          if (!('protectedPage' in result) || result.protectedPage !== 'miss')
            return { ok: false, code: 'CONFLICT' };
        }
      }
    }
    const bound = await run({
      action: 'bind-media-plan',
      jobId: progress.jobId,
      lease,
      planDigest,
      total: candidate.imageIds.length,
    });
    if (!bound.ok) return { ok: false, code: bound.code };
    if (!('media' in bound)) return { ok: false, code: 'CONFLICT' };
    let media = bound.media;
    const checkImage = options.checkImage;
    let byteImages = 0;
    let tryProtectedPage = !checkImage;
    if (candidate.previewReady && !candidate.issues.some((i) => i.severity === 'error'))
      for (
        let n = 0;
        n < maxProtectedImages &&
        byteImages < maxImages &&
        media.cursor < candidate.imageIds.length;
        n++
      ) {
        if (now() - startedAt >= budget - tailBudgetMs) break;
        const imageId = candidate.imageIds[media.cursor];
        if (imageId === undefined) return { ok: false, code: 'CORRUPT' };
        const pageIds = candidate.imageIds.slice(
          media.cursor,
          media.cursor + Math.min(8, maxProtectedImages - n),
        );
        if (tryProtectedPage && pageIds.length > 1) {
          const retained = await run({
            action: 'reserve-image-page',
            jobId: progress.jobId,
            lease,
            imageIds: pageIds,
          });
          if (!retained.ok) return { ok: false, code: retained.code };
          if ('reservation' in retained) {
            const checked = await run({
              action: 'check-protected-media-page',
              jobId: progress.jobId,
              lease,
              planDigest,
              index: media.cursor,
              imageIds: pageIds,
            });
            if (!checked.ok) return { ok: false, code: checked.code };
            if ('media' in checked) {
              if (checked.media.cursor !== media.cursor + pageIds.length)
                return { ok: false, code: 'CORRUPT' };
              media = checked.media;
              n += pageIds.length - 1;
              continue;
            }
            if (!('protectedPage' in checked) || checked.protectedPage !== 'miss')
              return { ok: false, code: 'CONFLICT' };
          } else if (!('protectedPage' in retained) || retained.protectedPage !== 'miss')
            return { ok: false, code: 'CONFLICT' };
          // A miss keeps the original single-image path and its four-image byte cap.
          tryProtectedPage = false;
        }
        const reservationCommand = {
          action: 'reserve-image-check' as const,
          jobId: progress.jobId,
          lease,
          imageId,
        };
        let reservation: CatalogPreparationJobResult;
        try {
          reservation = await run({
            ...reservationCommand,
            ...(!checkImage ? { includeProtectedHealth: true as const } : {}),
          });
        } catch (error) {
          const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
          if (
            checkImage ||
            now() - startedAt >= budget - tailBudgetMs ||
            (typeof code === 'string' &&
              [
                'FORBIDDEN',
                'VALIDATION_ERROR',
                'NOT_FOUND',
                'CORRUPT',
                'CONFLICT',
                'BUSY',
                'STALE',
                'DATABASE_TRANSACTION_CONFLICT',
              ].includes(code))
          )
            throw error;
          // The same guarded hold is idempotent if the optional read or its reply failed.
          reservation = await run(reservationCommand);
        }
        if (!reservation.ok) return { ok: false, code: reservation.code };
        const cached =
          !checkImage && 'reservation' in reservation ? reservation.protectedHealth : null;
        if (!cached) byteImages++;
        let checked: Awaited<ReturnType<typeof prepareStoredCatalogImage>>;
        if (cached) checked = { imageInputDigest: cached.inputDigest, health: cached };
        else if (checkImage) {
          const image = await get('images', imageId);
          const imageInputDigest = image ? storedCatalogImageInputDigest(image) : null;
          checked = { imageInputDigest, health: await checkImage(imageId) };
        } else
          checked = await prepareStoredCatalogImage(authority, {
            jobId: progress.jobId,
            lease,
            imageId,
          });
        if (
          !checkImage &&
          importer &&
          checked.health.status === 'retry' &&
          checked.health.reason === 'busy'
        ) {
          const image = await get('images', imageId);
          const lock = image ? readImageMutationState(image) : null;
          const completed =
            lock?.state === 'owned'
              ? candidate.sourcePhotos.find(
                  (photo) => photo.imageId === imageId && photo.completedOperationId === lock.owner,
                )
              : undefined;
          if (
            completed &&
            now() - startedAt < budget - tailBudgetMs &&
            (await importPhoto(completed.sourceUrl)).ok
          )
            checked = await prepareStoredCatalogImage(authority, {
              jobId: progress.jobId,
              lease,
              imageId,
            });
        }
        const { imageInputDigest, health } = checked;
        const advanced = await run({
          action: 'advance-media-check',
          jobId: progress.jobId,
          lease,
          planDigest,
          index: media.cursor,
          imageId,
          imageInputDigest,
          health,
        });
        if (!advanced.ok) return { ok: false, code: advanced.code };
        if (!('media' in advanced)) return { ok: false, code: 'CONFLICT' };
        media = advanced.media;
      }
    if (media.cursor === media.total) {
      const current = await inspectCatalogPreparationJob(authority, progress.jobId, lease, {
        mediaMode: 'defer',
      });
      if (!current.ok) return { ok: false, code: current.code };
      if (candidatePlanDigest(current) !== planDigest) return { ok: false, code: 'CONFLICT' };
      inspection = current;
    }
    const checked: Extract<WorkerResult, { ok: true }> = {
      ok: true,
      kind: 'unsealed-worker-step',
      jobId: progress.jobId,
      productId: progress.productId,
      media: {
        total: media.total,
        checked: media.cursor,
        verified: media.verified,
        invalid: media.invalid,
        retry: media.retry,
      },
      issues: inspection.issues,
      outcome:
        !inspection.previewReady || inspection.issues.some((i) => i.severity === 'error')
          ? 'blocked'
          : media.cursor < media.total
            ? 'partial'
            : media.invalid > 0
              ? 'blocked'
              : media.retry > 0 || inspection.issues.length > 0
                ? 'retryable'
                : 'checked',
    };
    const step =
      ready &&
      inspection.previewReady &&
      !inspection.issues.some((i) => i.severity === 'error') &&
      media.cursor === media.total &&
      media.verified === media.total &&
      media.invalid === 0 &&
      media.retry === 0
        ? await finishMedia(checked)
        : checked;
    return ready && step.ok && step.outcome !== 'ready'
      ? checkpointStep(step, inspection.previewReady)
      : step;
  }
  let result: WorkerResult;
  try {
    result = await work();
  } catch {
    result = { ok: false, code: 'UNAVAILABLE' };
  }
  try {
    if (!(result.ok && result.outcome === 'ready')) {
      const released = await run({ action: 'release', jobId: progress.jobId, lease });
      if (result.ok && !released.ok) return { ok: false, code: released.code };
    }
  } catch {
    return { ok: false, code: 'UNAVAILABLE' };
  }
  return ready && result.ok ? { ...result, kind: 'catalog-preparation-step' } : result;
}
