/** Bounded raw-gallery deltas for a live edit's row save, before detail re-approval. */
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import {
  IMAGE_MUTATION_STALE_MS,
  planCatalogProductSave,
  readImageMutationState,
} from './adapter.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import { CATALOG_CLOCK_SKEW_MS } from './approval-job-age.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { isStoredCatalogImageRecord } from './catalog-image-input.ts';
import {
  CATALOG_IMAGE_REFERENCE_LEDGER_FIELD,
  planCatalogImageReferenceSettlement,
} from './catalog-image-reference-store.ts';
import {
  CatalogImageReferenceError,
  type CatalogImageReferencePlan,
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
  stageCatalogImageReference,
} from './catalog-image-references.ts';
import type { OwnedReferenceStageFailure } from './catalog-operation-reference-stage.ts';

// Canonical historical raw galleries: 18 + 18; a new editor input: 9 + 18.
const MAX_CHANGES = 63;
const kind = 'catalog-owned-live-save-references-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const LiveSaveReferencesSchema = z
  .object({
    kind: z.literal(kind),
    changes: z
      .array(
        z
          .object({
            imageId: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .max(200),
            delta: z.union([z.literal(-1), z.literal(1)]),
          })
          .strict(),
      )
      .max(MAX_CHANGES),
    bindingDigest: digest,
    cursor: z.number().int().nonnegative().max(MAX_CHANGES),
    prefixDigest: digest,
  })
  .strict();
export type LiveSaveReferences = z.infer<typeof LiveSaveReferencesSchema>;
type Owner = {
  _id: string;
  productId: string;
  createdAt: string;
  operation: {
    intent: string;
    inputDigest: string;
    expectedUpdatedAt: string | null;
    base: unknown;
    policy: unknown;
    values: Record<string, unknown>;
  };
};
function bindingDigest(owner: Owner, plan: CatalogImageReferencePlan) {
  return alibabaPricingFingerprint([
    kind,
    owner._id,
    owner.productId,
    owner.operation.inputDigest,
    owner.operation.base,
    owner.operation.policy,
    plan.proof,
  ]);
}
function progress(
  owner: Owner,
  plan: CatalogImageReferencePlan,
  cursor: number,
): LiveSaveReferences {
  const binding = bindingDigest(owner, plan);
  return LiveSaveReferencesSchema.parse({
    kind,
    changes: plan.changes,
    bindingDigest: binding,
    cursor,
    prefixDigest: alibabaPricingFingerprint([kind, binding, cursor, plan.changes.slice(0, cursor)]),
  });
}
export function readLiveSaveReferences(
  owner: Owner,
  value: unknown,
): { references: LiveSaveReferences; plan: CatalogImageReferencePlan } | null {
  if (owner.operation.intent !== 'refresh-live' || !fitsJsonBudget(value, 16 * 1024, 8))
    return null;
  const parsed = LiveSaveReferencesSchema.safeParse(value);
  if (!parsed.success || parsed.data.cursor > parsed.data.changes.length) return null;
  try {
    const plan = buildCatalogImageReferencePlan(
      owner._id,
      parsed.data.changes.filter((c) => c.delta === -1).map((c) => c.imageId),
      parsed.data.changes.filter((c) => c.delta === 1).map((c) => c.imageId),
    );
    const expected = progress(owner, plan, parsed.data.cursor);
    return alibabaPricingFingerprint(expected) === alibabaPricingFingerprint(parsed.data)
      ? { references: parsed.data, plan }
      : null;
  } catch (error) {
    if (error instanceof CatalogImageReferenceError || error instanceof z.ZodError) return null;
    throw error;
  }
}
export function prepareLiveSaveReferences(
  owner: Owner,
  product: CollectionDoc,
): LiveSaveReferences | null {
  if (
    owner.operation.intent !== 'refresh-live' ||
    product._id !== owner.productId ||
    product.published !== true ||
    product.archived === true
  )
    return null;
  const candidate = planCatalogProductSave(
    product,
    {
      mode: 'update',
      productId: owner.productId,
      expectedUpdatedAt: owner.operation.expectedUpdatedAt,
      data: owner.operation.values,
    },
    owner.createdAt,
    { clearManualPricing: true },
  );
  if (
    candidate.result !== 'ready' ||
    candidate.doc.published !== true ||
    candidate.doc.archived === true
  )
    return null;
  try {
    const plan = buildCatalogImageReferencePlan(
      owner._id,
      catalogReferencedImageIds(product),
      catalogReferencedImageIds(candidate.doc),
    );
    return plan.changes.length <= MAX_CHANGES ? progress(owner, plan, 0) : null;
  } catch (error) {
    if (error instanceof CatalogImageReferenceError) return null;
    throw error;
  }
}
export function advanceLiveSaveReferences(
  owner: Owner,
  value: LiveSaveReferences,
  cursor: number,
): LiveSaveReferences {
  const read = readLiveSaveReferences(owner, value);
  if (
    !read ||
    !Number.isInteger(cursor) ||
    cursor < read.references.cursor ||
    cursor > read.plan.changes.length
  )
    throw Error('Invalid live save reference progress');
  return progress(owner, read.plan, cursor);
}

/** Pending entries grant no rights until the product, saved Root and proof commit together. */
export async function planLiveSaveReferencePage(
  tx: CatalogApprovalTransaction,
  plan: CatalogImageReferencePlan,
  cursor: number,
  owner: string,
  maxDocumentOperations: number,
  now = Date.now(),
): Promise<{ ok: true; images: CollectionDoc[]; nextCursor: number } | OwnedReferenceStageFailure> {
  const images: CollectionDoc[] = [];
  let used = 0;
  let nextCursor = cursor;
  for (let index = cursor; index < plan.changes.length && index < cursor + 20; index++) {
    const remaining = maxDocumentOperations - used;
    if (remaining < 2) break;
    const change = plan.changes[index];
    if (!change) return { ok: false, code: 'CONFLICT' };
    try {
      const loaded = await planCatalogImageReferenceSettlement(tx, {
        imageId: change.imageId,
        maxDocumentOperations: remaining,
      });
      if (loaded.snapshot.state !== 'counted') return { ok: false, code: 'MEDIA_NOT_READY' };
      used += loaded.snapshot.documentReads;
      if (change.delta === -1 && loaded.snapshot.effectiveCount < 1)
        return { ok: false, code: 'MEDIA_NOT_READY' };
      const image = loaded.snapshot.image;
      const lock = readImageMutationState(image);
      const age = lock.state === 'owned' ? now - Date.parse(lock.startedAt) : 0;
      if (lock.state === 'owned' && lock.owner !== owner && age < IMAGE_MUTATION_STALE_MS)
        return { ok: false, code: 'MEDIA_BUSY' };
      if (
        lock.state === 'corrupt' ||
        (lock.state === 'owned' &&
          (lock.owner !== owner || age < -CATALOG_CLOCK_SKEW_MS || age >= IMAGE_MUTATION_STALE_MS))
      )
        return { ok: false, code: 'MEDIA_NOT_READY' };
      // Removing an old raw reference must not require its damaged bytes to be repaired first.
      // New row-gallery references retain the existing active-upload contract; final detail approval verifies pixels.
      if (change.delta === 1 && !isStoredCatalogImageRecord(image, change.imageId))
        return { ok: false, code: 'MEDIA_NOT_READY' };
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
          updatedAt: new Date(now).toISOString(),
        });
        used++;
      }
      nextCursor = index + 1;
    } catch (error) {
      if (!(error instanceof CatalogImageReferenceError)) throw error;
      if (error.code === 'DOCUMENT_BUDGET_EXCEEDED') break;
      if (error.code === 'PENDING_FULL')
        return { ok: false, code: 'MEDIA_BUSY', pendingReferenceImageId: change.imageId };
      return { ok: false, code: 'MEDIA_NOT_READY' };
    }
  }
  return nextCursor > cursor
    ? { ok: true, images, nextCursor }
    : { ok: false, code: 'APPROVAL_TOO_LARGE' };
}
