/** Pure legacy approval shape shared by legacy and owned operation adapters. */
import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { CATALOG_DETAIL_VARIANT_MAX_COUNT } from '@vibelingan-channel/shared/catalog-detail-approval';
import { z } from 'zod';
export const APPROVAL_PAGE_SIZE = 20;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().trim().min(1).max(200);
export const ApprovalJobSchema = z
  .object({
    _id: digest,
    actorId: id,
    operationId: z.string().uuid(),
    requestDigest: digest,
    productId: id,
    productFingerprint: digest,
    expectedRevision: id.nullable(),
    revision: z.string().uuid(),
    publication: CatalogDetailPublicationSchema,
    publicPageSize: z.number().int().min(1).max(50).optional(),
    variantIds: z.array(id).max(CATALOG_DETAIL_VARIANT_MAX_COUNT),
    pageHashes: z.array(digest).max(500),
    nextPage: z.number().int().nonnegative(),
    state: z.enum(['staging', 'complete']),
    createdAt: z.string().datetime(),
    /** What a buyer saw from the source when this candidate was prepared (MIU-18). */
    sourceDigest: digest.optional(),
    /** Which row parts were still the supplier's own (MIU-39); linked products only. */
    supplierParts: z
      .object({ description: z.boolean(), gallery: z.boolean(), descriptionImages: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export type PreparedApproval = z.infer<typeof ApprovalJobSchema>;
/** Exact website edits/source generation reviewed; unrelated operational timestamps do not invalidate it. */
export function approvalProductFingerprint(product: CollectionDoc) {
  const fields = [
    '_id',
    'name',
    'description',
    'imageIds',
    'descriptionImageIds',
    'published',
    'archived',
    'productFamily',
    'category',
    'catalogPricingMode',
    'manualCatalogPricing',
    'unitPrice',
    'wholesalePrice',
    'moq',
    'alibabaPrimarySourceKey',
    'alibabaCatalogPricing',
    'detailSourceReady',
    'detailSourceOwner',
    'detailSourceRevision',
    'detailSourceManifest',
    'detailSourceCandidate',
    'detailSourceContentCandidate',
    'detailSourceNoteBlocksCandidate',
    // A manual product's facts come from these (MIU-27/28): an edit between
    // begin and finish must not slip into the approved version.
    'skuCode',
    'series',
    'modName',
    'modType',
  ];
  // Configuration photo choices (DEC-20); absent on older rows, which keep their fingerprint.
  if (product.configurationPhotos !== undefined) fields.push('configurationPhotos');
  if (product.catalogContentGeneration !== undefined) fields.push('catalogContentGeneration');
  if (product.catalogLifecycleVersion !== undefined) fields.push('catalogLifecycleVersion');
  if (product.catalogClassificationRevision !== undefined)
    fields.push('catalogClassificationRevision');
  if (product.detailSourceContentGeneration !== undefined)
    fields.push('detailSourceContentGeneration');
  return hash(Object.fromEntries(fields.map((field) => [field, product[field] ?? null])));
}

export function sameApprovalProduct(product: CollectionDoc | null, job: PreparedApproval) {
  if (!product || approvalProductFingerprint(product) !== job.productFingerprint) return false;
  if (product.catalogDetailPublication == null) return job.expectedRevision === null;
  const current = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  return (
    current.success &&
    current.data.header._id === job.productId &&
    current.data.revision === job.expectedRevision
  );
}
export function readApprovalJob(row: CollectionDoc | null) {
  const parsed = ApprovalJobSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const job = parsed.data;
  if (
    job.publication.header._id !== job.productId ||
    job.publication.revision !== job.revision ||
    job.publication.variantCount !== job.variantIds.length ||
    new Set(job.variantIds).size !== job.variantIds.length ||
    job.pageHashes.length !== Math.ceil(job.variantIds.length / APPROVAL_PAGE_SIZE) ||
    job.nextPage > job.pageHashes.length ||
    (job.state === 'complete' && job.nextPage !== job.pageHashes.length)
  )
    return undefined;
  return job;
}
