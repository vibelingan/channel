/** Server-only, bounded approval staging. No stage publishes a product. */
import { createHash, randomUUID } from 'node:crypto';
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
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
export type ApprovalStageResult = Progress | Failure;
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
    });
    if (Buffer.byteLength(JSON.stringify(job)) > 512 * 1024) return fail('VALIDATION_ERROR');
    return { ok: true, value: job };
  } catch {
    return fail('VALIDATION_ERROR');
  }
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
    },
  });
  const completed = { ...job, state: 'complete' as const };
  await tx.set(APPROVAL_JOBS, completed);
  return progress(completed);
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
