import { randomUUID } from 'node:crypto';
import { get, manageCatalogPreparationJob } from '@vibelingan-channel/db';
import { storedCatalogImageInputDigest } from '@vibelingan-channel/db/catalog-image-input';
import type {
  CatalogPreparationAuthority,
  CatalogPreparationJobResult,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import { sourceDigest } from '@vibelingan-channel/db/catalog-source-staging';
import type { CatalogIssue } from '@vibelingan-channel/shared/catalog-issues';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import type { readStoredCatalogImageHealth } from './catalog-image-health.ts';
import { prepareStoredCatalogImage } from './catalog-image-protection.ts';
import { inspectCatalogPreparationJob } from './catalog-preparation-job-inspect.ts';
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
      kind: 'unsealed-worker-step';
      outcome: 'partial' | 'checked' | 'blocked' | 'retryable';
      jobId: string;
      productId: string;
      media: Media;
      issues: readonly CatalogIssue[];
    };
function candidatePlanDigest(candidate: {
  inputDigest: string;
  contentGeneration: number;
  imageIds: readonly string[];
}) {
  return sourceDigest([
    CATALOG_PREPARATION_POLICY,
    candidate.inputDigest,
    candidate.contentGeneration,
    candidate.imageIds,
  ]);
}
const maxImages = 4;
const tailBudgetMs = 8000;
/** Backend-only bounded consumer. Historical checks and cursor never grant ready or publish. */
export async function runCatalogPreparationWorker(
  authority: CatalogPreparationAuthority,
  call: unknown,
  options: {
    now?: () => number;
    budgetMs?: number;
    checkImage?: typeof readStoredCatalogImageHealth;
  } = {},
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
  if (!('lease' in claimed)) return { ok: false, code: 'CONFLICT' };
  const { lease, progress } = claimed;
  const run = (command: Parameters<typeof manageCatalogPreparationJob>[1]) =>
    manageCatalogPreparationJob(authority, command);
  async function work(): Promise<WorkerResult> {
    const candidate = await inspectCatalogPreparationJob(authority, progress.jobId, lease, {
      mediaMode: 'defer',
    });
    if (!candidate.ok) return { ok: false, code: candidate.code };
    const planDigest = candidatePlanDigest(candidate);
    let inspection = candidate;
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
    if (candidate.previewReady && !candidate.issues.some((i) => i.severity === 'error'))
      for (let n = 0; n < maxImages && media.cursor < candidate.imageIds.length; n++) {
        if (now() - startedAt >= budget - tailBudgetMs) break;
        const renewed = await run({ action: 'renew', jobId: progress.jobId, lease });
        if (!renewed.ok) return { ok: false, code: renewed.code };
        const imageId = candidate.imageIds[media.cursor];
        if (imageId === undefined) return { ok: false, code: 'CORRUPT' };
        const checked = checkImage
          ? await (async () => {
              const image = await get('images', imageId);
              const imageInputDigest = image ? storedCatalogImageInputDigest(image) : null;
              return { imageInputDigest, health: await checkImage(imageId) };
            })()
          : await prepareStoredCatalogImage(authority, { jobId: progress.jobId, lease, imageId });
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
    return {
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
  }
  let result: WorkerResult;
  try {
    result = await work();
  } catch {
    result = { ok: false, code: 'UNAVAILABLE' };
  }
  try {
    const released = await run({ action: 'release', jobId: progress.jobId, lease });
    if (result.ok && !released.ok) return { ok: false, code: released.code };
  } catch {
    return { ok: false, code: 'UNAVAILABLE' };
  }
  return result;
}
