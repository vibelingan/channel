/** Plan one bounded private pending page; the caller commits images and original-root cursor together. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import { IMAGE_MUTATION_STALE_MS, readImageMutationState } from './adapter.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { ApprovalFailure } from './catalog-approval-job.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { isStoredCatalogImageRecord } from './catalog-image-input.ts';
import {
  CATALOG_IMAGE_REFERENCE_LEDGER_FIELD,
  planCatalogImageReferenceSettlement,
} from './catalog-image-reference-store.ts';
import {
  CATALOG_IMAGE_REFERENCE_MAX_LEAVES,
  CatalogImageReferenceError,
  type CatalogImageReferencePlan,
  catalogImageReferenceEntry,
  stageCatalogImageReference,
} from './catalog-image-references.ts';
import type { CatalogOwnedApprovalReferences } from './catalog-operation-references.ts';
import { readCatalogProtectedPixels } from './catalog-protected-pixels.ts';
const kind = 'catalog-owned-reference-stage-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogOwnedReferenceStageSchema = z
  .object({
    kind: z.literal(kind),
    bindingDigest: digest,
    cursor: z.number().int().nonnegative().safe().max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES),
    prefixDigest: digest,
  })
  .strict();
export type CatalogOwnedReferenceStage = z.infer<typeof CatalogOwnedReferenceStageSchema>;
export function ownedReferenceStageProgress(
  binding: CatalogOwnedApprovalReferences,
  plan: CatalogImageReferencePlan,
  cursor: number,
): CatalogOwnedReferenceStage {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > plan.changes.length)
    throw new CatalogImageReferenceError('INVALID_PLAN');
  let prefixDigest = alibabaPricingFingerprint([kind, binding.bindingDigest, 'prefix']);
  for (let index = 0; index < cursor; index++) {
    const change = plan.changes[index];
    if (!change) throw new CatalogImageReferenceError('INVALID_PLAN');
    prefixDigest = alibabaPricingFingerprint([prefixDigest, index, change.imageId, change.delta]);
  }
  return { kind, bindingDigest: binding.bindingDigest, cursor, prefixDigest };
}
export function readOwnedReferenceStage(
  binding: CatalogOwnedApprovalReferences,
  plan: CatalogImageReferencePlan,
  value: unknown,
): CatalogOwnedReferenceStage | null {
  if (value === undefined) return ownedReferenceStageProgress(binding, plan, 0);
  if (!fitsJsonBudget(value, 1024)) return null;
  const parsed = CatalogOwnedReferenceStageSchema.safeParse(value);
  if (!parsed.success || parsed.data.cursor > plan.changes.length) return null;
  const expected = ownedReferenceStageProgress(binding, plan, parsed.data.cursor);
  return alibabaPricingFingerprint(parsed.data) === alibabaPricingFingerprint(expected)
    ? parsed.data
    : null;
}
export async function planOwnedReferenceStagePage(
  tx: CatalogApprovalTransaction,
  plan: CatalogImageReferencePlan,
  cursor: number,
  maxDocumentOperations: number,
): Promise<
  | { ok: true; images: CollectionDoc[]; nextCursor: number; documentOperations: number }
  | ApprovalFailure
> {
  const images: CollectionDoc[] = [];
  let used = 0;
  let nextCursor = cursor;
  for (let index = cursor; index < plan.changes.length && index < cursor + 20; index++) {
    const remaining = maxDocumentOperations - used;
    if (remaining < 4) break;
    const change = plan.changes[index];
    if (!change) return { ok: false, code: 'CONFLICT' };
    try {
      // C1 reserves its possible image write; reserve two further reads for protected pixel evidence.
      const loaded = await planCatalogImageReferenceSettlement(tx, {
        imageId: change.imageId,
        maxDocumentOperations: remaining - 2,
      });
      if (loaded.snapshot.state !== 'counted') return { ok: false, code: 'MEDIA_NOT_READY' };
      used += loaded.snapshot.documentReads;
      const image = loaded.snapshot.image;
      const lock = readImageMutationState(image);
      const now = Date.now();
      if (lock.state === 'owned' && now - Date.parse(lock.startedAt) < IMAGE_MUTATION_STALE_MS)
        return { ok: false, code: 'MEDIA_BUSY' };
      if (!isStoredCatalogImageRecord(image, change.imageId) || lock.state !== 'free')
        return { ok: false, code: 'MEDIA_NOT_READY' };
      if (!(await readCatalogProtectedPixels(tx, image, now)))
        return { ok: false, code: 'MEDIA_NOT_READY' };
      used += 2;
      const current = loaded.settlement ?? image;
      const staged = stageCatalogImageReference(
        change.imageId,
        current.publishedRefCount,
        current[CATALOG_IMAGE_REFERENCE_LEDGER_FIELD],
        catalogImageReferenceEntry(plan, index),
      );
      if (staged.staged || loaded.settlement) {
        images.push({
          ...current,
          [CATALOG_IMAGE_REFERENCE_LEDGER_FIELD]: staged.ledger,
          updatedAt: new Date().toISOString(),
        });
        used++;
      }
      nextCursor = index + 1;
    } catch (error) {
      if (!(error instanceof CatalogImageReferenceError)) throw error;
      if (error.code === 'DOCUMENT_BUDGET_EXCEEDED') {
        used++;
        break;
      }
      if (error.code === 'PENDING_FULL') return { ok: false, code: 'MEDIA_BUSY' };
      return { ok: false, code: 'MEDIA_NOT_READY' };
    }
  }
  if (nextCursor === cursor) return { ok: false, code: 'APPROVAL_TOO_LARGE' };
  return { ok: true, images, nextCursor, documentOperations: used };
}
