import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
/**
 * Prepare for a manual product (MIU-28): the same approval pipeline as a synced
 * product, with an empty candidate the planner fills from the row (MIU-27). One
 * transaction of three operations: actor read, product read, product write.
 *
 * Approval reads configuration rows only from this manifest, which is empty, so
 * a product with manual configuration rows (the not-yet-live Excel import) is
 * refused rather than approved without them (DESIGN §5.2). Rows left by an
 * earlier Alibaba link are not the admin's and do not count. The server lists
 * the rows before calling; browsers never call this command.
 */
import { manualDetailCandidate } from '@vibelingan-channel/shared/catalog-detail';
import {
  CATALOG_DETAIL_VARIANT_MAX_COUNT,
  planCatalogDetailApproval,
} from '@vibelingan-channel/shared/catalog-detail-approval';
import {
  CatalogValidationError,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import type { ApprovalStageResult } from './catalog-detail-staging.ts';
import { sourceDigest } from './catalog-source-staging.ts';

const id = z.string().trim().min(1).max(200);

export const ManualSourceSchema = z
  .object({
    action: z.literal('manual-source'),
    productId: id,
    /** Active configuration rows of the product, listed by the server. */
    configurationRowIds: z.array(id).max(CATALOG_DETAIL_VARIANT_MAX_COUNT),
  })
  .strict();

export async function prepareManualSource(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ManualSourceSchema>,
): Promise<ApprovalStageResult> {
  const actor = await tx.get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ok: false, code: 'FORBIDDEN' };
  if (command.configurationRowIds.length > 0) return { ok: false, code: 'VALIDATION_ERROR' };
  const product = await tx.get('products', command.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const linked =
    typeof product.alibabaPrimarySourceKey === 'string' && product.alibabaPrimarySourceKey !== '';
  if (linked || product.archived === true) return { ok: false, code: 'CONFLICT' };
  const projection = projectManualSourceProduct(product);
  if (!projection) return { ok: false, code: 'VALIDATION_ERROR' };
  const { revision, product: prepared } = projection;
  const done = {
    ok: true as const,
    jobId: revision,
    revision,
    nextPage: 1,
    pages: 1,
    complete: true,
  };
  try {
    planCatalogDetailApproval({ product: prepared, variants: [], revision: 'manual-validation' });
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return catalogValidationFailure('manual-source', error.issues);
    throw error;
  }
  // Already prepared exactly so: confirm without writing (CloudBase may answer
  // an identical write with "0 updated", which the adapter treats as failure).
  if (isDeepStrictEqual(prepared, product)) return done;
  await tx.set('products', prepared);
  return done;
}

/** The same manual projection used by native preparation and owned candidate reads. */
export function projectManualSourceProduct(product: CollectionDoc) {
  const generation = product.catalogContentGeneration ?? 0;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0)
    return null;
  const revision = sourceDigest([
    'manual',
    product._id,
    'v1',
    ...(product.catalogContentGeneration == null ? [] : ['content-generation', generation]),
  ]);
  // A product unlinked from Alibaba must not carry its old source fingerprint
  // into a manual approval.
  const {
    detailSourcePublicDigest: _previous,
    detailSourceContentGeneration: _previousGeneration,
    ...current
  } = product;
  const prepared = {
    ...current,
    detailSourceOwner: `manual:${product._id}`,
    detailSourceRevision: revision,
    ...(product.catalogContentGeneration == null
      ? {}
      : { detailSourceContentGeneration: generation }),
    detailSourceManifest: { revision, variantIds: [] },
    detailSourceNextPage: 1,
    detailSourceReady: true,
    detailSourceCandidate: manualDetailCandidate({
      _id: product._id,
      name: typeof product.name === 'string' ? product.name : '',
    }),
    detailSourceContentCandidate: null,
    detailSourceNoteBlocksCandidate: null,
  };
  return { revision, product: prepared };
}
