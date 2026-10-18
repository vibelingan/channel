/** Server-only, bounded approval staging. No stage publishes a product. */
import { createHash, randomUUID } from 'node:crypto';
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  CatalogPriceSummarySchema,
} from '@vibelingan-channel/shared/catalog-detail';
import {
  CATALOG_APPROVAL_JOB_MAX_BYTES,
  catalogVariantCapacityIssues,
  planCatalogDetailApproval,
} from '@vibelingan-channel/shared/catalog-detail-approval';
import { CATALOG_DETAIL_PAGINATION_POLICY } from '@vibelingan-channel/shared/catalog-detail-pagination';
import {
  CatalogIssueSchema,
  CatalogValidationError,
  catalogIssuesFromZod,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import { IMAGE_MUTATION_STALE_MS, readImageMutationState } from './adapter.ts';
import { APPROVAL_JOB_MAX_AGE_MS } from './approval-job-age.ts';
import { planApprovalImageReferences } from './catalog-approval-image-references.ts';
import {
  APPROVAL_PAGE_SIZE,
  type ApprovalFailure as Failure,
  ApprovalJobSchema as JobSchema,
  type PreparedApproval,
  approvalProductFingerprint,
  readApprovalJob as readJob,
  sameApprovalProduct as sameProduct,
} from './catalog-approval-job.ts';
export {
  type ApprovalFailure,
  APPROVAL_PAGE_SIZE,
  type PreparedApproval,
  approvalProductFingerprint,
} from './catalog-approval-job.ts';
import { isApprovalPage, prepareApprovalPage, storeApprovalPage } from './catalog-approval-page.ts';
import { ChangeAuditMarkSchema, markChangeAudit } from './catalog-change-audit-store.ts';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
import { ManualSourceSchema, prepareManualSource } from './catalog-manual-staging.ts';
import {
  CatalogPreparationCommitSchema,
  type CatalogPreparationStoreResult,
  storeCatalogPreparationReport,
} from './catalog-preparation-store.ts';
import {
  ProductOperationApprovalBeginSchema,
  ProductOperationApprovalPageSchema,
  ProductOperationCancelSchema,
  ProductOperationGetSchema,
  ProductOperationMediaSchema,
  ProductOperationReferencesSchema,
  type ProductOperationResult,
  ProductOperationStartSchema,
  runProductOperation,
} from './catalog-product-operation.ts';
import { publicationContentFingerprint } from './catalog-publication-fingerprint.ts';
import { SourcePageSchema, stageSourcePage } from './catalog-source-staging.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';
import { sdkAnswer } from './cloudbase-sdk-answer.ts';
export { approvedVariantDocumentId } from './catalog-detail-storage.ts';
export {
  captureProductOperationSave,
  prepareProductOperationSave,
  productOperationSaveReceipt,
} from './catalog-product-operation.ts';
import {
  CatalogApprovalCommandSchema,
  type CatalogApprovalTransaction,
  prepareCatalogApprovalPlan,
} from './catalog-detail-commit.ts';

export const APPROVAL_JOBS = 'catalogDetailApprovals';
export const APPROVED_VARIANTS = 'catalogDetailVariants';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().trim().min(1).max(200);
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
export type ApprovalStageResult =
  | ProductOperationResult
  | Progress
  | Failure
  | Backfill
  | Extract<CatalogPreparationStoreResult, { ok: true }>;
const PriceSummaryBackfillSchema = z
  .object({
    action: z.literal('price-summary-backfill'),
    productId: id,
    revision: id,
    priceSummary: CatalogPriceSummarySchema,
  })
  .strict();
const PersistenceCommandSchema = z.discriminatedUnion('action', [
  ProductOperationStartSchema,
  ProductOperationApprovalPageSchema,
  ProductOperationCancelSchema,
  ProductOperationApprovalBeginSchema,
  ProductOperationGetSchema,
  ProductOperationMediaSchema,
  ProductOperationReferencesSchema,
  SourcePageSchema,
  CatalogPreparationCommitSchema,
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

/** Capture before transaction startup or a local lock can yield to the caller. */
export function captureApprovalPersistenceCommand(
  input: ApprovalPersistenceCommand,
): { ok: true; command: ApprovalPersistenceCommand } | Failure {
  try {
    return { ok: true, command: structuredClone(input) };
  } catch {
    return catalogValidationFailure('commit', [
      CatalogIssueSchema.parse({
        code: 'INVALID_VALUE',
        stage: 'commit',
        path: 'data',
        severity: 'error',
        remedy: 'reload',
      }),
    ]);
  }
}
const fail = (code: Failure['code']): Failure => ({ ok: false, code });
const progress = (job: PreparedApproval): Progress => ({
  ok: true,
  jobId: job._id,
  revision: job.revision,
  nextPage: job.nextPage,
  pages: job.pageHashes.length,
  complete: job.state === 'complete',
});

/** Caller supplies server-read rows, never a browser-submitted candidate or invented binding. */
export function prepareStagedApproval(
  actorId: string,
  input: unknown,
  product: CollectionDoc,
  rows: CollectionDoc[],
): { ok: true; value: PreparedApproval } | Failure {
  try {
    const command = CatalogApprovalCommandSchema.parse(input);
    if (command.productId !== product._id) return fail('CONFLICT');
    const revision = randomUUID();
    const prepared = prepareCatalogApprovalPlan(product, rows, revision);
    if (prepared.digest !== command.expectedDigest) return fail('CONFLICT');
    const plan = prepared.plan;
    const job = buildStagedApprovalJob(actorId, command, product, plan, revision);
    const capacity = stagedApprovalCapacityIssues(plan, job);
    if (capacity.length) return catalogValidationFailure('begin', capacity);
    // Missing source photos cannot mask invalid content or a task that cannot be stored.
    if (
      rows.some(
        (row) =>
          Array.isArray(row.detailSourceUnboundMediaSources) &&
          row.detailSourceUnboundMediaSources.length > 0,
      )
    )
      return fail('MEDIA_NOT_READY');
    return { ok: true, value: job };
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return catalogValidationFailure('begin', error.issues);
    if (error instanceof z.ZodError)
      return catalogValidationFailure(
        'begin',
        catalogIssuesFromZod(error.issues, input, { stage: 'commit', remedy: 'system-repair' }),
      );
    return fail('VALIDATION_ERROR');
  }
}

type ApprovalPlan = ReturnType<typeof prepareCatalogApprovalPlan>['plan'];
const capacityIdentity = '\u0001'.repeat(200);
const capacityRevision = '00000000-0000-4000-8000-000000000000';

/** Check the complete plan, including storage metadata, before any staging or media work. */
export function catalogStagedApprovalCapacityIssues(product: CollectionDoc, plan: ApprovalPlan) {
  const job = buildStagedApprovalJob(
    capacityIdentity,
    {
      productId: product._id,
      operationId: capacityRevision,
      expectedRevision: capacityIdentity,
      expectedDigest: '0'.repeat(64),
    },
    product,
    plan,
    capacityRevision,
  );
  return stagedApprovalCapacityIssues(plan, job);
}

function stagedApprovalCapacityIssues(plan: ApprovalPlan, job: PreparedApproval) {
  const issues = catalogVariantCapacityIssues(plan.variants);
  // These two identities can be any legal 200-code-unit string. JSON control escapes
  // reserve six bytes per code unit, so later admins/history cannot exceed this check.
  const jobBytes = Buffer.byteLength(
    JSON.stringify({
      ...job,
      actorId: capacityIdentity,
      expectedRevision: capacityIdentity,
    }),
  );
  if (jobBytes > CATALOG_APPROVAL_JOB_MAX_BYTES)
    issues.push(
      CatalogIssueSchema.parse({
        code: 'TOO_LARGE',
        stage: 'commit',
        path: 'data',
        severity: 'error',
        remedy: 'system-repair',
        expected: { maxBytes: CATALOG_APPROVAL_JOB_MAX_BYTES },
        observed: { bytes: jobBytes },
      }),
    );
  return issues;
}

function buildStagedApprovalJob(
  actorId: string,
  command: z.infer<typeof CatalogApprovalCommandSchema>,
  product: CollectionDoc,
  plan: ApprovalPlan,
  revision: string,
): PreparedApproval {
  const pageHashes = [];
  for (let offset = 0; offset < plan.variants.length; offset += APPROVAL_PAGE_SIZE)
    pageHashes.push(hash(plan.variants.slice(offset, offset + APPROVAL_PAGE_SIZE)));
  return JobSchema.parse({
    _id: hash([actorId, product._id, command.operationId]),
    actorId,
    operationId: command.operationId,
    requestDigest: hash({ actorId, command }),
    productId: product._id,
    productFingerprint: approvalProductFingerprint(product),
    expectedRevision: command.expectedRevision,
    revision,
    publication: { ...plan.publication, revision },
    ...(plan.publicPageSize === undefined ? {} : { publicPageSize: plan.publicPageSize }),
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
}

/**
 * Which parts of the row are still the supplier's own (MIU-39). The next
 * approval may replace only those with the supplier's newer version. A part
 * is the supplier's when the row shows exactly the supplier's current version
 * (photos: every one imported, in order), or when it was the supplier's at
 * the last approval and nobody has edited it since (the row still equals the
 * approved version) — e.g. newer photos left for a later approval. The finish
 * fingerprint covers the row's text and photos; the supplier media record is
 * read when begin runs, outside the transaction.
 */
function supplierParts(product: CollectionDoc) {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const field = (value: unknown, key: string) =>
    value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const ids = (value: unknown) => (Array.isArray(value) ? value : []);
  const paths = (value: unknown) => ids(value).map((id) => `/api/images/${String(id)}`);
  const supplierText = field(product.detailSourceCandidate, 'descriptionText');
  const media = product.detailSourceSupplierMedia;
  const isSupplier = (row: unknown, key: string) => {
    const supplier = field(media, key);
    return Array.isArray(supplier) && same(ids(row), supplier);
  };
  const before = field(product.catalogDetailApprovalReceipt, 'supplierParts');
  const header = field(product.catalogDetailPublication, 'header');
  const stillOwned = (key: string, unedited: boolean) => field(before, key) === true && unedited;
  return {
    description:
      text(product.description) === text(supplierText) ||
      stillOwned(
        'description',
        text(product.description) === text(field(header, 'descriptionText')),
      ),
    gallery:
      isSupplier(product.imageIds, 'gallery') ||
      stillOwned('gallery', same(paths(product.imageIds), ids(field(header, 'images')))),
    descriptionImages:
      isSupplier(product.descriptionImageIds, 'descriptionImages') ||
      stillOwned(
        'descriptionImages',
        same(paths(product.descriptionImageIds), ids(field(header, 'descriptionImages'))),
      ),
  };
}

async function isAdmin(tx: CatalogApprovalTransaction, actorId: string) {
  const actor = await tx.get('users', actorId);
  return actor?.role === 'admin' && actor.status !== 'suspended';
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
  if (!isApprovalPage(job, page)) return fail('VALIDATION_ERROR');
  if (page < job.nextPage || job.state === 'complete') return progress(job);
  const product = await tx.get('products', job.productId);
  if (!product || !sameProduct(product, job)) return fail('CONFLICT');
  const plan = await prepareApprovalPage(tx, product, job, page);
  if (!plan.ok) return plan;
  const next = { ...job, nextPage: plan.nextPage };
  await storeApprovalPage(tx, plan, next);
  return progress(next);
}

/** Reserve two of CloudBase's 100 operations for transaction overhead. */
export const CATALOG_APPROVAL_FINISH_MAX_OPERATIONS = 98;

/** The finish transaction reads every referenced image and writes only live-use changes. */
export function planStagedApprovalMedia(
  product: CollectionDoc,
  publication: PreparedApproval['publication'],
) {
  const before = new Set(catalogReferencedImageIds(product));
  const after = new Set(
    catalogReferencedImageIds({ ...product, catalogDetailPublication: publication }),
  );
  const imageIds = new Set([...before, ...after]);
  const delta = (imageId: string) =>
    product.published === true ? Number(after.has(imageId)) - Number(before.has(imageId)) : 0;
  // Actor/job/product reads plus product/job writes; unchanged photos stay read-only (DEC-21).
  const operations = 5 + imageIds.size + [...imageIds].filter((id) => delta(id) !== 0).length;
  return { imageIds, delta, operations };
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
  // Too old to finish: the admin starts the approval again (a new job).
  if (!(Date.now() - Date.parse(job.createdAt) <= APPROVAL_JOB_MAX_AGE_MS))
    return fail('APPROVAL_EXPIRED');
  if (job.nextPage !== job.pageHashes.length) return fail('SOURCE_NOT_READY');
  if (!sameProduct(product, job)) return fail('CONFLICT');
  const images: CollectionDoc[] = [];
  const media = planStagedApprovalMedia(product, job.publication);
  if (media.operations > CATALOG_APPROVAL_FINISH_MAX_OPERATIONS) return fail('APPROVAL_TOO_LARGE');
  for (const imageId of media.imageIds) {
    const image = await tx.get('images', imageId);
    const lock = image ? readImageMutationState(image) : null;
    // Held right now by a save or delete (a fresh lock): free again in a
    // moment, so "busy, try again". A stale or corrupt lock does not clear by
    // waiting, so it stays "not ready".
    if (
      lock?.state === 'owned' &&
      Date.now() - Date.parse(lock.startedAt) < IMAGE_MUTATION_STALE_MS
    )
      return fail('MEDIA_BUSY');
    if (
      !image ||
      image._id !== imageId ||
      image.status !== 'active' ||
      lock?.state !== 'free' ||
      (image.storageProvider !== 'cloudbase-storage' && image.storageProvider !== 'local-disk') ||
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
  const references = await planApprovalImageReferences(
    tx,
    images,
    media.delta,
    CATALOG_APPROVAL_FINISH_MAX_OPERATIONS - media.operations,
  );
  if (!references.ok) return references;
  // Photos are shared (a seller's banners appear in hundreds of products), so
  // approval only READS them; it writes a photo only when the number of live
  // products showing it changes (DEC-21). Writing every photo made any two
  // approvals that share one collide. A delete cannot slip in meanwhile: delete
  // paths lock the photo and refuse while an unfinished approval job lists it,
  // and this transaction refuses a locked photo (checked above).
  for (const { image, delta } of references.images) {
    if (delta === 0) continue;
    await tx.set('images', image);
  }
  await tx.set('products', {
    ...product,
    catalogDetailPublication: publication,
    catalogDetailPagination: {
      policyVersion: CATALOG_DETAIL_PAGINATION_POLICY,
      revision: job.revision,
      pageSize: job.publicPageSize ?? 50,
    },
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
  if (!parsed.success)
    return catalogValidationFailure(
      'commit',
      catalogIssuesFromZod(parsed.error.issues, input, { stage: 'commit', remedy: 'reload' }),
    );
  const actor = id.safeParse(actorId);
  if (!actor.success)
    return catalogValidationFailure(
      'commit',
      catalogIssuesFromZod(actor.error.issues, actorId, {
        stage: 'commit',
        remedy: 'sign-in',
        prefix: ['actorId'],
      }),
    );
  const command = parsed.data;
  if (
    command.action === 'operation-start' ||
    command.action === 'operation-get' ||
    command.action === 'operation-approval-begin' ||
    command.action === 'operation-approval-page' ||
    command.action === 'operation-cancel' ||
    command.action === 'operation-approval-media' ||
    command.action === 'operation-approval-references'
  )
    return runProductOperation(tx, actorId, command);
  if (command.action === 'preparation-report')
    return storeCatalogPreparationReport(tx, actorId, command);
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
  const captured = captureApprovalPersistenceCommand(input);
  if (!captured.ok) return Promise.resolve(captured);
  return db.runTransaction((tx) =>
    runStagedApproval(
      {
        get: async (collection, id) => {
          const response = sdkAnswer(await tx.collection(collection).doc(id).get()).data;
          const row = Array.isArray(response) ? response[0] : response;
          if (row == null) return null;
          if (typeof row !== 'object' || Array.isArray(row) || !('_id' in row) || row._id !== id)
            throw new Error('Malformed approval document');
          return row as CollectionDoc;
        },
        set: async (collection, row) => {
          const { _id, ...data } = row;
          const result = sdkAnswer(await tx.collection(collection).doc(_id).set(data));
          // Installed @cloudbase/database 1.4.3 transaction set returns upserted
          // for a new document. A response with neither acknowledgement aborts.
          if (result.updated !== 1 && !result.upserted?.some((item) => item._id === _id))
            throw new Error('Approval write not confirmed');
        },
      },
      actorId,
      captured.command,
    ),
  );
}
