/** Server-only, bounded approval staging. No stage publishes a product. */
import { createHash, randomUUID } from 'node:crypto';
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  CatalogPriceSummarySchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';
import { ChangeAuditMarkSchema, markChangeAudit } from './catalog-change-audit-store.ts';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
import { ManualSourceSchema, prepareManualSource } from './catalog-manual-staging.ts';
import { publicationContentFingerprint } from './catalog-publication-fingerprint.ts';
import { SourcePageSchema, stageSourcePage } from './catalog-source-staging.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';
export { approvedVariantDocumentId } from './catalog-detail-storage.ts';
import {
  CatalogApprovalCommandSchema,
  type CatalogApprovalTransaction,
  catalogApprovalDigest,
} from './catalog-detail-commit.ts';

export const APPROVAL_JOBS = 'catalogDetailApprovals';
export const APPROVED_VARIANTS = 'catalogDetailVariants';
export const APPROVAL_PAGE_SIZE = 20;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().trim().min(1).max(200);
const JobSchema = z
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
    variantIds: z.array(id).max(10000),
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
export type PreparedApproval = z.infer<typeof JobSchema>;
type Failure = {
  ok: false;
  code:
    | 'VALIDATION_ERROR'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'MEDIA_NOT_READY'
    | 'APPROVAL_TOO_LARGE'
    | 'SOURCE_NOT_READY';
};
type Progress = {
  ok: true;
  jobId: string;
  revision: string;
  nextPage: number;
  pages: number;
  complete: boolean;
};
/** Outcome of the one-time price summary backfill (MIU-6). */
type Backfill = {
  ok: true;
  /** Distinct from the review result's `kind` so `'kind' in result` narrowing stays valid. */
  backfill: 'applied' | 'skipped';
  reason?: 'revision-changed' | 'already-present' | 'not-approved' | 'archived';
};
export type ApprovalStageResult = Progress | Failure | Backfill;
const PriceSummaryBackfillSchema = z
  .object({
    action: z.literal('price-summary-backfill'),
    productId: id,
    revision: id,
    priceSummary: CatalogPriceSummarySchema,
  })
  .strict();
const PersistenceCommandSchema = z.discriminatedUnion('action', [
  SourcePageSchema,
  z.object({ action: z.literal('begin'), prepared: JobSchema }).strict(),
  z
    .object({
      action: z.literal('page'),
      jobId: digest,
      page: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z.object({ action: z.literal('finish'), jobId: digest }).strict(),
  PriceSummaryBackfillSchema,
  ChangeAuditMarkSchema,
  ManualSourceSchema,
]);
/** Internal adapter command. HTTP handlers must never forward a submitted `prepared` object. */
export type ApprovalPersistenceCommand = z.infer<typeof PersistenceCommandSchema>;
const fail = (code: Failure['code']): Failure => ({ ok: false, code });
const progress = (job: PreparedApproval): Progress => ({
  ok: true,
  jobId: job._id,
  revision: job.revision,
  nextPage: job.nextPage,
  pages: job.pageHashes.length,
  complete: job.state === 'complete',
});

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
  return hash(Object.fromEntries(fields.map((field) => [field, product[field] ?? null])));
}

/** Caller supplies server-read rows, never a browser-submitted candidate or invented binding. */
export function prepareStagedApproval(
  actorId: string,
  input: unknown,
  product: CollectionDoc,
  rows: CollectionDoc[],
): { ok: true; value: PreparedApproval } | Failure {
  try {
    const command = CatalogApprovalCommandSchema.parse(input);
    if (
      command.productId !== product._id ||
      catalogApprovalDigest(product, rows) !== command.expectedDigest
    )
      return fail('CONFLICT');
    const revision = randomUUID();
    const plan = planCatalogDetailApproval({ product, variants: rows, revision });
    // Known source mappings may not silently disappear from an approved SKU.
    if (
      rows.some(
        (row) =>
          Array.isArray(row.detailSourceUnboundMediaSources) &&
          row.detailSourceUnboundMediaSources.length > 0,
      )
    )
      return fail('MEDIA_NOT_READY');
    if (plan.variants.some((variant) => Buffer.byteLength(JSON.stringify(variant)) > 128 * 1024))
      return fail('VALIDATION_ERROR');
    const pageHashes = [];
    for (let offset = 0; offset < plan.variants.length; offset += APPROVAL_PAGE_SIZE)
      pageHashes.push(hash(plan.variants.slice(offset, offset + APPROVAL_PAGE_SIZE)));
    const job = JobSchema.parse({
      _id: hash([actorId, product._id, command.operationId]),
      actorId,
      operationId: command.operationId,
      requestDigest: hash({ actorId, command }),
      productId: product._id,
      productFingerprint: approvalProductFingerprint(product),
      expectedRevision: command.expectedRevision,
      revision,
      publication: plan.publication,
      variantIds: plan.variants.map((variant) => variant.id),
      pageHashes,
      nextPage: 0,
      state: 'staging',
      createdAt: new Date().toISOString(),
      // Absent for products prepared before MIU-17; the change audit covers them.
      ...(typeof product.detailSourcePublicDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(product.detailSourcePublicDigest)
        ? { sourceDigest: product.detailSourcePublicDigest }
        : {}),
      ...(String(product.detailSourceOwner).startsWith('alibaba:')
        ? { supplierParts: supplierParts(product) }
        : {}),
    });
    if (Buffer.byteLength(JSON.stringify(job)) > 512 * 1024) return fail('VALIDATION_ERROR');
    return { ok: true, value: job };
  } catch {
    return fail('VALIDATION_ERROR');
  }
}

/**
 * Which parts of the row are still the supplier's own (MIU-39). The next
 * approval may replace only those with the supplier's newer version. Photos
 * count only when every supplier photo is imported and the row shows exactly
 * those, in order. The finish fingerprint covers the row's text and photos;
 * the supplier media record is read when begin runs, outside the transaction.
 */
function supplierParts(product: CollectionDoc) {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const candidate = product.detailSourceCandidate;
  const supplierText =
    candidate && typeof candidate === 'object' ? Reflect.get(candidate, 'descriptionText') : '';
  const media = product.detailSourceSupplierMedia;
  const supplier = (key: string) =>
    media && typeof media === 'object' ? Reflect.get(media, key) : undefined;
  const same = (row: unknown, ids: unknown) =>
    Array.isArray(ids) && JSON.stringify(Array.isArray(row) ? row : []) === JSON.stringify(ids);
  return {
    description: text(product.description) === text(supplierText),
    gallery: same(product.imageIds, supplier('gallery')),
    descriptionImages: same(product.descriptionImageIds, supplier('descriptionImages')),
  };
}

async function isAdmin(tx: CatalogApprovalTransaction, actorId: string) {
  const actor = await tx.get('users', actorId);
  return actor?.role === 'admin' && actor.status !== 'suspended';
}
function sameProduct(product: CollectionDoc | null, job: PreparedApproval) {
  if (!product || approvalProductFingerprint(product) !== job.productFingerprint) return false;
  if (product.catalogDetailPublication == null) return job.expectedRevision === null;
  const current = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  return (
    current.success &&
    current.data.header._id === job.productId &&
    current.data.revision === job.expectedRevision
  );
}
function readJob(row: CollectionDoc | null) {
  const parsed = JobSchema.safeParse(row);
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

export async function beginStagedApproval(
  tx: CatalogApprovalTransaction,
  actorId: string,
  prepared: PreparedApproval,
): Promise<Progress | Failure> {
  if (!(await isAdmin(tx, actorId)) || actorId !== prepared.actorId) return fail('FORBIDDEN');
  const previous = await tx.get(APPROVAL_JOBS, prepared._id);
  if (previous) {
    const job = readJob(previous);
    if (!job || job.requestDigest !== prepared.requestDigest) return fail('CONFLICT');
    return job.state === 'complete' ? finishStagedApproval(tx, actorId, job._id) : progress(job);
  }
  if (!readJob(prepared) || prepared.state !== 'staging' || prepared.nextPage !== 0)
    return fail('VALIDATION_ERROR');
  const product = await tx.get('products', prepared.productId);
  if (!sameProduct(product, prepared)) return fail('CONFLICT');
  await tx.set(APPROVAL_JOBS, prepared);
  return progress(prepared);
}

export async function stageApprovalPage(
  tx: CatalogApprovalTransaction,
  actorId: string,
  jobId: string,
  page: number,
): Promise<Progress | Failure> {
  if (!(await isAdmin(tx, actorId))) return fail('FORBIDDEN');
  const job = readJob(await tx.get(APPROVAL_JOBS, jobId));
  if (!job) return fail('NOT_FOUND');
  if (job.actorId !== actorId) return fail('FORBIDDEN');
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    page >= job.pageHashes.length ||
    page > job.nextPage
  )
    return fail('VALIDATION_ERROR');
  if (page < job.nextPage || job.state === 'complete') return progress(job);
  const product = await tx.get('products', job.productId);
  if (!product || !sameProduct(product, job)) return fail('CONFLICT');
  const offset = page * APPROVAL_PAGE_SIZE;
  const rows: CollectionDoc[] = [];
  for (const variantId of job.variantIds.slice(offset, offset + APPROVAL_PAGE_SIZE)) {
    const row = await tx.get('productVariants', variantId);
    if (!row || row.detailSourceRevision !== product.detailSourceRevision)
      return fail('SOURCE_NOT_READY');
    rows.push(row);
  }
  let variants: ReturnType<typeof planCatalogDetailApproval>['variants'];
  try {
    variants = planCatalogDetailApproval({
      product,
      variants: rows,
      revision: job.revision,
    }).variants;
  } catch {
    return fail('VALIDATION_ERROR');
  }
  if (hash(variants) !== job.pageHashes[page]) return fail('CONFLICT');
  // Snapshot rows and progress are one transaction. Rollback never advances a cursor.
  for (const [position, variant] of variants.entries()) {
    await tx.set(APPROVED_VARIANTS, {
      _id: approvedVariantDocumentId(job.productId, job.revision, variant.id),
      productId: job.productId,
      variantId: variant.id,
      catalogDetailRevision: job.revision,
      catalogDetailPosition: offset + position,
      catalogDetailApproved: variant,
    });
  }
  const next = { ...job, nextPage: page + 1 };
  await tx.set(APPROVAL_JOBS, next);
  return progress(next);
}

/**
 * Images one approval may touch, old and new versions together: finish reads
 * and writes each once, plus five fixed operations (actor/job/product reads,
 * product/job writes), within the 98 of a 100-operation transaction.
 */
export const APPROVAL_IMAGE_LIMIT = 46;

export async function finishStagedApproval(
  tx: CatalogApprovalTransaction,
  actorId: string,
  jobId: string,
): Promise<Progress | Failure> {
  if (!(await isAdmin(tx, actorId))) return fail('FORBIDDEN');
  const job = readJob(await tx.get(APPROVAL_JOBS, jobId));
  if (!job) return fail('NOT_FOUND');
  if (job.actorId !== actorId) return fail('FORBIDDEN');
  const product = await tx.get('products', job.productId);
  if (!product) return fail('NOT_FOUND');
  if (job.state === 'complete') {
    const current = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
    return current.success &&
      current.data.header._id === job.productId &&
      current.data.revision === job.revision
      ? progress(job)
      : fail('CONFLICT');
  }
  if (job.nextPage !== job.pageHashes.length) return fail('SOURCE_NOT_READY');
  if (!sameProduct(product, job)) return fail('CONFLICT');
  const images: CollectionDoc[] = [];
  const beforeImages = new Set(catalogReferencedImageIds(product));
  const afterImages = new Set(
    catalogReferencedImageIds({ ...product, catalogDetailPublication: job.publication }),
  );
  // Keep finish within the transaction budget, including retired snapshot
  // images. Refuse before writing rather than partially approve.
  if (new Set([...beforeImages, ...afterImages]).size > APPROVAL_IMAGE_LIMIT)
    return fail('APPROVAL_TOO_LARGE');
  for (const imageId of new Set([...beforeImages, ...afterImages])) {
    const image = await tx.get('images', imageId);
    if (
      !image ||
      image.status !== 'active' ||
      readImageMutationState(image).state !== 'free' ||
      !['cloudbase-storage', 'local-disk'].includes(String(image.storageProvider)) ||
      (Object.hasOwn(image, 'publishedRefCount') &&
        (typeof image.publishedRefCount !== 'number' ||
          !Number.isSafeInteger(image.publishedRefCount) ||
          image.publishedRefCount < 0))
    )
      return fail('MEDIA_NOT_READY');
    images.push(image);
  }
  const publication = CatalogDetailPublicationSchema.parse({
    ...job.publication,
    variantStorage: 'immutable-v1',
  });
  for (const image of images) {
    const delta =
      product.published === true
        ? Number(afterImages.has(image._id)) - Number(beforeImages.has(image._id))
        : 0;
    const count = typeof image.publishedRefCount === 'number' ? image.publishedRefCount : 0;
    if (count + delta < 0) return fail('MEDIA_NOT_READY');
  }
  for (const image of images) {
    const delta =
      product.published === true
        ? Number(afterImages.has(image._id)) - Number(beforeImages.has(image._id))
        : 0;
    await tx.set('images', {
      ...image,
      ...(delta ? { publishedRefCount: Number(image.publishedRefCount ?? 0) + delta } : {}),
      catalogDetailApprovalFence: job.revision,
    });
  }
  await tx.set('products', {
    ...product,
    catalogDetailPublication: publication,
    catalogDetailApprovalReceipt: {
      contentFingerprint: publicationContentFingerprint(product),
      operationId: job.operationId,
      revision: job.revision,
      requestDigest: job.requestDigest,
      actorId,
      variantCount: job.variantIds.length,
      approvedAt: new Date().toISOString(),
      ...(job.sourceDigest === undefined ? {} : { sourceDigest: job.sourceDigest }),
      ...(job.supplierParts === undefined ? {} : { supplierParts: job.supplierParts }),
    },
  });
  const completed = { ...job, state: 'complete' as const };
  await tx.set(APPROVAL_JOBS, completed);
  return progress(completed);
}

/**
 * Adds a price summary to an existing approved version without re-approving it.
 * Writes only `catalogDetailPublication.priceSummary`; the revision, receipts and
 * publication state are untouched (no approval fingerprint covers the
 * publication, so existing approvals stay valid).
 */
export async function backfillPublicationPriceSummary(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof PriceSummaryBackfillSchema>,
): Promise<ApprovalStageResult> {
  if (!(await isAdmin(tx, actorId))) return fail('FORBIDDEN');
  const product = await tx.get('products', command.productId);
  if (!product) return fail('NOT_FOUND');
  const skipped = (reason: NonNullable<Backfill['reason']>): Backfill => ({
    ok: true,
    backfill: 'skipped',
    reason,
  });
  const current = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  if (!current.success || current.data.header._id !== product._id) return skipped('not-approved');
  if (current.data.revision !== command.revision) return skipped('revision-changed');
  if (current.data.priceSummary) return skipped('already-present');
  const next = {
    ...(product.catalogDetailPublication as Record<string, unknown>),
    priceSummary: command.priceSummary,
  };
  if (!CatalogDetailPublicationSchema.safeParse(next).success) return fail('VALIDATION_ERROR');
  await tx.set('products', { ...product, catalogDetailPublication: next });
  return { ok: true, backfill: 'applied' };
}

export async function runStagedApproval(
  tx: CatalogApprovalTransaction,
  actorId: string,
  input: ApprovalPersistenceCommand,
): Promise<ApprovalStageResult> {
  const parsed = PersistenceCommandSchema.safeParse(input);
  if (!parsed.success || !id.safeParse(actorId).success) return fail('VALIDATION_ERROR');
  const command = parsed.data;
  if (command.action === 'source-page') return stageSourcePage(tx, actorId, command);
  if (command.action === 'price-summary-backfill')
    return backfillPublicationPriceSummary(tx, actorId, command);
  if (command.action === 'change-audit-mark') return markChangeAudit(tx, actorId, command);
  if (command.action === 'manual-source') return prepareManualSource(tx, actorId, command);
  if (command.action === 'begin') return beginStagedApproval(tx, actorId, command.prepared);
  if (command.action === 'page') return stageApprovalPage(tx, actorId, command.jobId, command.page);
  return finishStagedApproval(tx, actorId, command.jobId);
}

export function persistStagedApprovalInCloud(
  db: NodeSdkDatabase,
  actorId: string,
  input: ApprovalPersistenceCommand,
): Promise<ApprovalStageResult> {
  return db.runTransaction((tx) =>
    runStagedApproval(
      {
        get: async (collection, id) => {
          const response = (await tx.collection(collection).doc(id).get()).data;
          const row = Array.isArray(response) ? response[0] : response;
          if (row == null) return null;
          if (typeof row !== 'object' || Array.isArray(row) || !('_id' in row) || row._id !== id)
            throw new Error('Malformed approval document');
          return row as CollectionDoc;
        },
        set: async (collection, row) => {
          const { _id, ...data } = row;
          const result = await tx.collection(collection).doc(_id).set(data);
          // Installed @cloudbase/database 1.4.3 transaction set returns upserted
          // for a new document. A response with neither acknowledgement aborts.
          if (result.updated !== 1 && !result.upserted?.some((item) => item._id === _id))
            throw new Error('Approval write not confirmed');
        },
      },
      actorId,
      input,
    ),
  );
}
