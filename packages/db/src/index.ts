import {
  type CatalogImageReferenceReadCommand,
  CatalogImageReferenceReadSchema,
} from './catalog-image-reference-store.ts';
import { isImageReferenceWriteConflict } from './catalog-image-reference-write.ts';
export {
  CATALOG_IMAGE_REFERENCE_LEDGER_FIELD,
  emptyCatalogImageReferenceCount,
} from './catalog-image-reference-store.ts';
export function readCatalogImageReference(command: CatalogImageReferenceReadCommand) {
  const input = CatalogImageReferenceReadSchema.parse(command);
  const adapter = db();
  if (!adapter.readCatalogImageReference)
    throw Error('Image reference snapshot adapter is not configured');
  return adapter.readCatalogImageReference(input);
}
import { approvalImageHoldCancelled } from './catalog-approval-image-hold.ts';
import { findCatalogPreparationImageHold } from './catalog-preparation-image-hold.ts';
import { readCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { type ImageUploadCommand, ImageUploadCommandSchema } from './image-upload.ts';
export {
  runImageUpload,
  imageUploadInputDigest,
  hasImageUploadCompletion,
  canReverifyLegacyImageUpload,
  ImageUploadCommandSchema,
} from './image-upload.ts';
export type { ImageUploadCommand, ImageUploadResult } from './image-upload.ts';
export function manageImageUpload(command: ImageUploadCommand) {
  const input = ImageUploadCommandSchema.parse(command);
  const adapter = db();
  if (!adapter.manageImageUpload) throw new Error('Image upload adapter is not configured');
  return adapter.manageImageUpload(input);
}
import {
  type SourceMediaImportCommand,
  SourceMediaImportCommandSchema,
} from './source-media-import.ts';
export {
  runSourceMediaImport,
  SOURCE_MEDIA_IMPORT_OWNER,
  SOURCE_MEDIA_IMPORT_LEASE_MS,
  SourceMediaImportCommandSchema,
  SourceMediaTargetSchema,
} from './source-media-import.ts';
export type {
  SourceMediaImportCommand,
  SourceMediaImportResult,
  SourceMediaTarget,
} from './source-media-import.ts';
export function manageSourceMediaImport(command: SourceMediaImportCommand) {
  const input = SourceMediaImportCommandSchema.parse(command);
  const adapter = db();
  if (!adapter.manageSourceMediaImport)
    throw new Error('Source media import adapter is not configured');
  return adapter.manageSourceMediaImport(input);
}
/**
 * Repository facade. Backend code (cloud functions, local-server) imports these
 * functions and never touches a concrete database. The active `DbAdapter` is
 * injected via `setAdapter` at startup.
 */
import {
  type CollectionDoc,
  type ListQuery,
  type ListResult,
  PUBLIC_CATALOG_COLLECTIONS,
  type ProductFamily,
  type SortClause,
  buildWriteSchema,
  catalogReferencedImageIds,
  getCollection,
} from '@vibelingan-channel/shared';
import type {
  AlibabaLeaseGrant,
  AlibabaLeaseGuard,
  AlibabaProductMutationInput,
  AlibabaProductMutationResult,
  AlibabaSyncRunClaimResult,
  CatalogProductSaveInput,
  CatalogProductSaveResult,
  CatalogSourceObservationUpsertResult,
  DbAdapter,
} from './adapter.ts';
import type { ImageMutationAcquireResult, ImageMutationReleaseResult } from './adapter.ts';
import { ALIBABA_SYNC_LEASE_COLLECTION, holdsAlibabaLease } from './adapter.ts';
export type {
  ProductOperationRecord,
  ProductOperationResult,
} from './catalog-product-operation.ts';
import { APPROVAL_JOB_DELETE_MARGIN_MS, APPROVAL_JOB_MAX_AGE_MS } from './approval-job-age.ts';
import { type ImageDeletionCommand, ImageDeletionCommandSchema } from './image-deletion.ts';
export { executeImageDeletion } from './image-deletion-runner.ts';
export {
  runImageDeletion,
  readImageDeletionIntent,
  ImageDeletionCommandSchema,
} from './image-deletion.ts';
export type {
  ImageDeletionCommand,
  ImageDeletionResult,
  ImageDeletionIntent,
  ImageDeletionStore,
} from './image-deletion.ts';

export function manageImageDeletion(command: ImageDeletionCommand) {
  const input = ImageDeletionCommandSchema.parse(command);
  const adapter = db();
  if (!adapter.manageImageDeletion) throw new Error('Image deletion adapter is not configured');
  return adapter.manageImageDeletion(input);
}

import { runCatalogApprovalWorkflow } from './catalog-detail-workflow.ts';
import { persistOwnedReferencePageWithRecovery } from './catalog-operation-reference-recovery.ts';
import { runProductOperationWorkflow } from './catalog-product-operation-workflow.ts';
export function manageCatalogCategory(actorId: string, input: unknown) {
  const adapter = db();
  if (!adapter.manageCatalogCategory)
    throw new Error('Catalog classification adapter is not configured');
  return adapter.manageCatalogCategory(actorId, input);
}
export function getCatalogTaxonomy(family: ProductFamily): Promise<CollectionDoc | null> {
  return db().get('catalogTaxonomies', family);
}
export {
  ALIBABA_PRODUCT_LINK_LIMIT,
  alibabaPricingFingerprint,
  alibabaLinkRevision,
  flagForReview,
  readImageMutationState,
  transitionImageMutationAcquire,
  transitionImageMutationRelease,
  ALIBABA_SYNC_LEASE_COLLECTION,
  ALIBABA_SYNC_LEASE_RENEW_MS,
  ALIBABA_SYNC_LEASE_TTL_MS,
  holdsAlibabaLease,
  planCatalogProductSave,
  readAlibabaLeaseState,
  transitionAlibabaLeaseAcquire,
  transitionAlibabaLeaseRelease,
  transitionAlibabaLeaseRenew,
} from './adapter.ts';

export type {
  AdapterListQuery,
  AlibabaPricingEvidenceExpectation,
  AlibabaLeaseGrant,
  AlibabaLeaseGuard,
  AlibabaLeaseState,
  AlibabaProductLinkIdentity,
  AlibabaProductMutationInput,
  AlibabaProductMutationResult,
  AlibabaSyncRunClaimResult,
  CatalogProductIdentity,
  CatalogProductSaveInput,
  CatalogProductSavePlan,
  CatalogProductSaveResult,
  CatalogSourceObservationUpsertResult,
  DbAdapter,
  ImageMutationAcquireResult,
  ImageMutationReleaseResult,
  ImageMutationState,
} from './adapter.ts';

/**
 * The active adapter is stored on `globalThis` rather than a plain module
 * variable. Under pnpm, a package can be loaded as more than one module
 * instance (different symlink-resolved URLs), which would give each instance
 * its own singleton. Anchoring to `globalThis` keeps a single shared adapter
 * regardless of how many times this module is instantiated.
 */
const ADAPTER_KEY = Symbol.for('@vibelingan-channel/db.adapter');

type AdapterHost = { [ADAPTER_KEY]?: DbAdapter | null };

export function setAdapter(next: DbAdapter): void {
  (globalThis as AdapterHost)[ADAPTER_KEY] = next;
}

function db(): DbAdapter {
  const adapter = (globalThis as AdapterHost)[ADAPTER_KEY];
  if (!adapter) {
    throw new Error('@vibelingan-channel/db: no adapter configured. Call setAdapter() at startup.');
  }
  return adapter;
}

const DEFAULT_PAGE_SIZE = 20;
export async function mutateAlibabaProduct(
  input: AlibabaProductMutationInput,
): Promise<AlibabaProductMutationResult> {
  const adapter = db();
  if (!adapter.mutateAlibabaProduct) {
    throw new Error('@vibelingan-channel/db: Alibaba product mutation is not implemented.');
  }
  return adapter.mutateAlibabaProduct(input);
}
export async function manageCatalogPreparationJob(
  authority: import('./catalog-preparation-jobs.ts').CatalogPreparationAuthority,
  command: import('./catalog-preparation-jobs.ts').CatalogPreparationJobCommand,
  now?: number,
) {
  const adapter = db();
  if (!adapter.manageCatalogPreparationJob)
    throw new Error('Preparation job persistence unavailable');
  return adapter.manageCatalogPreparationJob(authority, command, now);
}
export function manageCatalogProductOperation(actorId: string, input: unknown) {
  return runProductOperationWorkflow({ persist: persistCatalogDetailApproval }, actorId, input);
}
export function manageCatalogDetailApproval(actorId: string, input: unknown) {
  return runCatalogApprovalWorkflow({ get, persist: persistCatalogDetailApproval }, actorId, input);
}
export async function persistCatalogDetailApproval(
  actorId: string,
  input: import('./catalog-detail-staging.ts').ApprovalPersistenceCommand,
  referenceRecovery?: unknown,
) {
  const adapter = db();
  if (!adapter.persistCatalogDetailApproval)
    throw new Error('Staged approval persistence unavailable');
  if (input.action === 'operation-approval-reference-page')
    return persistOwnedReferencePageWithRecovery(
      {
        get: adapter.get.bind(adapter),
        persist: adapter.persistCatalogDetailApproval.bind(adapter),
      },
      actorId,
      input,
      referenceRecovery,
    );
  return adapter.persistCatalogDetailApproval(actorId, input);
}
export async function approveCatalogDetail(actorId: string, input: unknown) {
  const adapter = db();
  if (!adapter.approveCatalogDetail) throw new Error('Catalog approval persistence unavailable');
  return adapter.approveCatalogDetail(actorId, input);
}
export async function submitCatalogQuote(input: unknown) {
  const adapter = db();
  if (!adapter.submitCatalogQuote) throw new Error('Catalog inquiry persistence unavailable');
  return adapter.submitCatalogQuote(input);
}
export async function manageCatalogInquiry(actorId: string, input: unknown) {
  const adapter = db();
  if (!adapter.manageCatalogInquiry) throw new Error('Catalog inquiry persistence unavailable');
  return adapter.manageCatalogInquiry(actorId, input);
}
const MAX_PAGE_SIZE = 100;

function assertKnown(collection: string) {
  const def = getCollection(collection);
  if (!def) {
    throw new UnknownCollectionError(collection);
  }
  return def;
}

export class UnknownCollectionError extends Error {
  constructor(public readonly collection: string) {
    super(`Unknown collection: ${collection}`);
    this.name = 'UnknownCollectionError';
  }
}

export async function list(query: ListQuery): Promise<ListResult<CollectionDoc>> {
  assertKnown(query.collection);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
  return db().list({
    collection: query.collection,
    ...(query.productFamily ? { productFamily: query.productFamily } : {}),
    ...(query.needsClassification ? { needsClassification: true } : {}),
    ...(query.hidePreparing ? { hidePreparing: true } : {}),
    ...(query.catalogReadiness ? { catalogReadiness: query.catalogReadiness } : {}),
    ...(query.catalogListView !== undefined ? { catalogListView: query.catalogListView } : {}),
    ...(query.productSubcategories ? { productSubcategories: query.productSubcategories } : {}),
    page,
    pageSize,
    search: (query.search ?? '').trim(),
    ...(query.searchFields ? { searchFields: query.searchFields } : {}),
    ...(query.filter ? { filter: query.filter } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
  });
}

export function get(collection: string, id: string): Promise<CollectionDoc | null> {
  assertKnown(collection);
  return db().get(collection, id);
}

/** Find the first document where `field` exactly equals `value`. */
export function findByField(
  collection: string,
  field: string,
  value: unknown,
): Promise<CollectionDoc | null> {
  assertKnown(collection);
  return db().findByField(collection, field, value);
}

/** Validate `data` against the collection registry, then create the document. */
export function create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
  const def = assertKnown(collection);
  const parsed = buildWriteSchema(def).parse(data);
  return db().create(collection, parsed);
}

/** Validate a partial `data` against the registry, then update the document. */
export function update(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc | null> {
  const def = assertKnown(collection);
  const parsed = buildWriteSchema(def).partial().parse(data);
  return db().update(collection, id, parsed);
}

/**
 * Trusted, server-side write that bypasses the registry write-schema. Used by
 * the auth flow to set server-managed fields (e.g. `passwordHash`) that are
 * marked read-only for the generic admin CRUD.
 */
export function createDoc(
  collection: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc> {
  assertKnown(collection);
  return db().create(collection, data);
}

/** Trusted, server-side partial update that bypasses the registry write-schema. */
export function updateDoc(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc | null> {
  assertKnown(collection);
  return db().update(collection, id, data);
}

/**
 * Trusted, server-side atomic increment of one numeric field, bypassing the
 * registry write-schema. Used to maintain server-managed counters such as
 * `images.publishedRefCount` (read-only on the generic CRUD surface). Returns
 * the new value, or `null` if the document does not exist. Image reference counters
 * also return null for a legacy row whose counter is absent, preserving its unknown base.
 */
export function incrementField(
  collection: string,
  id: string,
  field: string,
  delta: number,
): Promise<number | null> {
  assertKnown(collection);
  // The delta feeds CloudBase db.command.inc and the local read-modify-write
  // path directly. A non-finite or fractional delta (NaN/Infinity/0.5) would
  // poison the counter — and since publishedRefCount gates public visibility,
  // a NaN silently hides the image (NaN > 0 === false). Guard the one choke
  // point so counters stay integral.
  if (!Number.isInteger(delta)) {
    throw new Error(
      `@vibelingan-channel/db: incrementField delta must be a finite integer (got ${delta}).`,
    );
  }
  return db().incrementField(collection, id, field, delta);
}

function requireImageMutationInput(imageId: string, value: string, label: string): void {
  if (imageId.trim().length === 0 || value.trim().length === 0) {
    throw new Error(`@vibelingan-channel/db: invalid image mutation ${label}.`);
  }
}

function requireCanonicalIso(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`@vibelingan-channel/db: invalid image mutation ${label}.`);
  }
}

export function acquireImageMutation(
  imageId: string,
  owner: string,
  startedAt: string,
): Promise<ImageMutationAcquireResult> {
  requireImageMutationInput(imageId, owner, 'owner');
  requireCanonicalIso(startedAt, 'start time');
  const adapter = db();
  if (!adapter.acquireImageMutation) {
    throw new Error('@vibelingan-channel/db: image mutation ownership is not implemented.');
  }
  return adapter.acquireImageMutation(imageId, owner, startedAt);
}

export function releaseImageMutation(
  imageId: string,
  owner: string,
): Promise<ImageMutationReleaseResult> {
  requireImageMutationInput(imageId, owner, 'owner');
  const adapter = db();
  if (!adapter.releaseImageMutation) {
    throw new Error('@vibelingan-channel/db: image mutation ownership is not implemented.');
  }
  return adapter.releaseImageMutation(imageId, owner);
}

/**
 * Compute the next value of an atomic numeric counter for the read-modify-write
 * adapters (local JSON + in-memory test fakes), mirroring CloudBase
 * `db.command.inc` semantics: an absent/null field initialises from 0, while an
 * existing value that is not a finite number is a corruption error — CloudBase's
 * `$inc` likewise rejects a non-numeric field, so the local path must not
 * silently coerce it to 0 and diverge. `delta` is assumed already validated
 * (finite integer) by `incrementField`.
 */
export { nextCounterValue } from './counter-value.ts';

export function remove(collection: string, id: string): Promise<boolean> {
  assertKnown(collection);
  return db().remove(collection, id);
}

// ---------------------------------------------------------------------------
// Deterministic-id writes + Alibaba sync lease facades (ARCHITECTURE §9).
// Trusted server-side surfaces: they bypass the registry write-schema exactly
// like createDoc/updateDoc, and throw when the wired adapter has not
// implemented the optional methods (acquireImageMutation precedent).
// ---------------------------------------------------------------------------

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`@vibelingan-channel/db: ${label} must be a non-empty string.`);
  }
}

function requireCanonicalIsoInstant(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`@vibelingan-channel/db: ${label} must be a canonical ISO instant.`);
  }
}

function requireLeaseNumbers(fence: number | undefined, ttlMs: number | undefined): void {
  if (fence !== undefined && (!Number.isSafeInteger(fence) || fence < 1)) {
    throw new Error('@vibelingan-channel/db: lease fence must be a positive integer.');
  }
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) {
    throw new Error('@vibelingan-channel/db: lease ttlMs must be a positive integer.');
  }
}

/**
 * Single-winner create-if-absent with a deterministic id. Stamps
 * createdAt/updatedAt unless the caller supplied explicit instants
 * (deterministic replay), matching the reserve-first rate-limiter precedent.
 */
export function createDocWithId(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<'created' | 'exists'> {
  assertKnown(collection);
  requireNonEmpty(id, 'document id');
  const adapter = db();
  if (!adapter.createDocWithId) {
    throw new Error('@vibelingan-channel/db: createDocWithId is not implemented by this adapter.');
  }
  const now = new Date().toISOString();
  return adapter.createDocWithId(collection, id, {
    createdAt: now,
    updatedAt: now,
    ...data,
  });
}

/** Delete a deterministic-id document only while its owner field still matches. */
export function removeDocIfFieldEquals(
  collection: string,
  id: string,
  field: string,
  expectedValue: unknown,
): Promise<boolean> {
  assertKnown(collection);
  requireNonEmpty(id, 'document id');
  requireNonEmpty(field, 'field');
  const adapter = db();
  if (!adapter.removeDocIfFieldEquals) {
    throw new Error(
      '@vibelingan-channel/db: removeDocIfFieldEquals is not implemented by this adapter.',
    );
  }
  return adapter.removeDocIfFieldEquals(collection, id, field, expectedValue);
}

/** Atomically save a product together with its normalized slug/SKU ownership. */
export function saveCatalogProductWithIdentities(
  input: CatalogProductSaveInput,
): Promise<CatalogProductSaveResult> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.mode !== 'create' && input.mode !== 'update') ||
    !input.data ||
    typeof input.data !== 'object' ||
    Array.isArray(input.data)
  ) {
    throw new Error('@vibelingan-channel/db: invalid catalog product save input.');
  }
  requireNonEmpty(input.productId, 'product id');
  const expected = input.expectedAlibabaIdentity;
  if (
    expected !== undefined &&
    (input.mode !== 'update' ||
      !expected ||
      typeof expected !== 'object' ||
      Array.isArray(expected) ||
      (expected.revision !== null &&
        (!Number.isSafeInteger(expected.revision) || expected.revision < 0)) ||
      (expected.primarySourceKey !== null && typeof expected.primarySourceKey !== 'string'))
  ) {
    throw new Error('@vibelingan-channel/db: invalid expected Alibaba identity.');
  }
  const adapter = db();
  if (!adapter.saveCatalogProductWithIdentities) {
    throw new Error(
      '@vibelingan-channel/db: saveCatalogProductWithIdentities is not implemented by this adapter.',
    );
  }
  return adapter.saveCatalogProductWithIdentities(input);
}

/** Create-or-patch with a deterministic id; returns the resulting document. */
export function upsertDocWithId(
  collection: string,
  id: string,
  data: Record<string, unknown>,
  createOnly: Record<string, unknown> = {},
): Promise<CollectionDoc> {
  assertKnown(collection);
  requireNonEmpty(id, 'document id');
  const adapter = db();
  if (!adapter.upsertDocWithId) {
    throw new Error('@vibelingan-channel/db: upsertDocWithId is not implemented by this adapter.');
  }
  return adapter.upsertDocWithId(collection, id, data, createOnly);
}

export function upsertCatalogSourceObservation(
  id: string,
  data: Record<string, unknown>,
  createOnly: Record<string, unknown>,
): Promise<CatalogSourceObservationUpsertResult> {
  assertKnown('catalogSourceObservations');
  requireNonEmpty(id, 'document id');
  if (typeof data.observedAt !== 'string' || Number.isNaN(Date.parse(data.observedAt))) {
    throw new Error('@vibelingan-channel/db: source observation requires a valid observedAt.');
  }
  const adapter = db();
  if (!adapter.upsertCatalogSourceObservation) {
    throw new Error(
      '@vibelingan-channel/db: upsertCatalogSourceObservation is not implemented by this adapter.',
    );
  }
  return adapter.upsertCatalogSourceObservation(id, data, createOnly);
}

export function acquireAlibabaSyncLease(
  connectionId: string,
  holder: string,
  now: string,
  ttlMs: number,
): Promise<AlibabaLeaseGrant> {
  requireNonEmpty(connectionId, 'connectionId');
  requireNonEmpty(holder, 'lease holder');
  requireCanonicalIsoInstant(now, 'lease acquire time');
  requireLeaseNumbers(undefined, ttlMs);
  const adapter = db();
  if (!adapter.acquireAlibabaSyncLease) {
    throw new Error('@vibelingan-channel/db: the Alibaba sync lease is not implemented.');
  }
  return adapter.acquireAlibabaSyncLease(connectionId, holder, now, ttlMs);
}

export function renewAlibabaSyncLease(
  connectionId: string,
  holder: string,
  fence: number,
  now: string,
  ttlMs: number,
): Promise<boolean> {
  requireNonEmpty(connectionId, 'connectionId');
  requireNonEmpty(holder, 'lease holder');
  requireCanonicalIsoInstant(now, 'lease renew time');
  requireLeaseNumbers(fence, ttlMs);
  const adapter = db();
  if (!adapter.renewAlibabaSyncLease) {
    throw new Error('@vibelingan-channel/db: the Alibaba sync lease is not implemented.');
  }
  return adapter.renewAlibabaSyncLease(connectionId, holder, fence, now, ttlMs);
}

export function releaseAlibabaSyncLease(
  connectionId: string,
  holder: string,
  fence: number,
  now: string,
): Promise<boolean> {
  requireNonEmpty(connectionId, 'connectionId');
  requireNonEmpty(holder, 'lease holder');
  requireCanonicalIsoInstant(now, 'lease release time');
  requireLeaseNumbers(fence, undefined);
  const adapter = db();
  if (!adapter.releaseAlibabaSyncLease) {
    throw new Error('@vibelingan-channel/db: the Alibaba sync lease is not implemented.');
  }
  return adapter.releaseAlibabaSyncLease(connectionId, holder, fence, now);
}

/**
 * Cheap read-only pre-check: does holder+fence still hold the lease right
 * now? NEVER a substitute for the fenced write — guarded mutations go through
 * `updateDocWithAlibabaLease`, which re-verifies inside the transaction
 * (REVISION_R1 E2).
 */
export async function assertAlibabaSyncLease(
  connectionId: string,
  holder: string,
  fence: number,
  now: string,
): Promise<boolean> {
  requireNonEmpty(connectionId, 'connectionId');
  requireNonEmpty(holder, 'lease holder');
  requireCanonicalIsoInstant(now, 'lease assert time');
  requireLeaseNumbers(fence, undefined);
  const doc = await db().get(ALIBABA_SYNC_LEASE_COLLECTION, connectionId);
  return holdsAlibabaLease(doc, holder, fence, now);
}

/** Fenced conditional write — see `DbAdapter.updateDocWithAlibabaLease`. */
export function updateDocWithAlibabaLease(
  collection: string,
  id: string,
  patch: Record<string, unknown>,
  guard: AlibabaLeaseGuard,
): Promise<boolean> {
  assertKnown(collection);
  requireNonEmpty(id, 'document id');
  requireNonEmpty(guard.connectionId, 'connectionId');
  requireNonEmpty(guard.holder, 'lease holder');
  requireCanonicalIsoInstant(guard.now, 'guard time');
  requireLeaseNumbers(guard.fence, undefined);
  const adapter = db();
  if (!adapter.updateDocWithAlibabaLease) {
    throw new Error('@vibelingan-channel/db: fenced writes are not implemented by this adapter.');
  }
  return adapter.updateDocWithAlibabaLease(collection, id, patch, guard);
}

/** Fenced deterministic-id create-or-patch — see `DbAdapter.upsertDocWithAlibabaLease`. */
export function upsertDocWithAlibabaLease(
  collection: string,
  id: string,
  patch: Record<string, unknown>,
  createOnly: Record<string, unknown>,
  guard: AlibabaLeaseGuard,
): Promise<boolean> {
  assertKnown(collection);
  requireNonEmpty(id, 'document id');
  requireNonEmpty(guard.connectionId, 'connectionId');
  requireNonEmpty(guard.holder, 'lease holder');
  requireCanonicalIsoInstant(guard.now, 'guard time');
  requireLeaseNumbers(guard.fence, undefined);
  const adapter = db();
  if (!adapter.upsertDocWithAlibabaLease) {
    throw new Error('@vibelingan-channel/db: fenced upserts are not implemented by this adapter.');
  }
  return adapter.upsertDocWithAlibabaLease(collection, id, patch, createOnly, guard);
}

/** Atomically create a run row and claim the shared Alibaba checkpoint slot. */
export function claimAlibabaSyncRun(
  runId: string,
  run: Record<string, unknown>,
  checkpointPatch: Record<string, unknown>,
  guard: AlibabaLeaseGuard,
): Promise<AlibabaSyncRunClaimResult> {
  requireNonEmpty(runId, 'run id');
  requireNonEmpty(guard.connectionId, 'connectionId');
  requireNonEmpty(guard.holder, 'lease holder');
  requireCanonicalIsoInstant(guard.now, 'guard time');
  requireLeaseNumbers(guard.fence, undefined);
  const adapter = db();
  if (!adapter.claimAlibabaSyncRun) {
    throw new Error('@vibelingan-channel/db: atomic Alibaba run claim is not implemented.');
  }
  return adapter.claimAlibabaSyncRun(runId, run, checkpointPatch, guard);
}

/**
 * Apply the same partial update to many documents. Validated against the
 * registry write-schema once, then applied per id. Returns the updated docs.
 */
export async function batchUpdate(
  collection: string,
  ids: string[],
  data: Record<string, unknown>,
): Promise<CollectionDoc[]> {
  const def = assertKnown(collection);
  const parsed = buildWriteSchema(def).partial().parse(data);
  const results: CollectionDoc[] = [];
  for (const id of ids) {
    const updated = await db().update(collection, id, parsed);
    if (updated) {
      results.push(updated);
    }
  }
  return results;
}

/**
 * Remove many documents by id. Returns the ids actually removed (each at most
 * once — a repeated or already-gone id is reported only on the call that
 * deleted it). Callers that maintain derived state (e.g. publishedRefCount) can
 * thus apply side effects for exactly the deletes that happened, not for ids
 * they merely intended to delete.
 */
export async function batchRemove(collection: string, ids: string[]): Promise<string[]> {
  assertKnown(collection);
  const removed: string[] = [];
  for (const id of ids) {
    if (await db().remove(collection, id)) {
      removed.push(id);
    }
  }
  return removed;
}

const BACKFILL_PAGE_SIZE = 100;

// Page by the unique `_id` so skip/limit pagination has a TOTAL order. The
// default sort (createdAt desc) ties for bulk-seeded/migrated rows, and CloudBase
// (Mongo-style skip/limit) can then skip or duplicate a tied row across a page
// boundary — which would corrupt the absolute counter this backfill writes. `_id`
// is unique, so paging is skip/duplicate-free. Order is irrelevant to the tally.
const STABLE_PAGE_SORT: SortClause[] = [{ field: '_id', dir: 'asc' }];

export interface BackfillRefCountsReport {
  dryRun: boolean;
  imagesScanned: number;
  changes: { imageId: string; from: number | null; to: number }[];
  skipped?: { imageId: string; reason: 'managed-references' | 'missing' }[];
}

/**
 * The unfinished approval job, if any, whose version would publish this photo.
 *
 * Approval reads shared photos and never writes them (DEC-21), so a delete
 * path cannot rely on a write conflict with the approval. Delete paths call
 * this after locking the photo: a job begun before the lock is found here; a
 * job begun after it finds the photo locked and refuses inside its own
 * transaction. A job older than the approval limit (plus a margin) is
 * ignored: it can no longer finish.
 */
export async function unfinishedApprovalUsingImage(imageId: string): Promise<string | null> {
  const startedAfter = new Date(
    Date.now() - APPROVAL_JOB_MAX_AGE_MS - APPROVAL_JOB_DELETE_MARGIN_MS,
  ).toISOString();
  const adapter = db();
  if (adapter.findUnfinishedApprovalUsingImage)
    return adapter.findUnfinishedApprovalUsingImage(imageId, startedAfter);
  let afterId = '';
  for (;;) {
    const page = await list({
      collection: 'catalogDetailApprovals',
      page: 1,
      pageSize: 100,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
      filter: {
        combinator: 'and',
        clauses: [
          { field: 'state', op: 'eq', value: 'staging' },
          // Older jobs can no longer finish (finishStagedApproval refuses them).
          { field: 'createdAt', op: 'gt', value: startedAfter },
          ...(afterId ? [{ field: '_id', op: 'gt' as const, value: afterId }] : []),
        ],
      },
    });
    for (const job of page.items) {
      if (approvalImageHoldCancelled(job)) continue;
      const productId = typeof job.productId === 'string' ? job.productId : '';
      if (
        productId &&
        catalogReferencedImageIds({
          _id: productId,
          catalogDetailPublication: job.publication,
        }).includes(imageId)
      )
        return productId;
    }
    if (page.items.length < 100) return null;
    const last = page.items.at(-1)?._id;
    // Fail closed: a page we cannot continue past must not read as "no approval".
    if (typeof last !== 'string' || !last) throw new Error('Approval job without an id');
    afterId = last;
  }
}

/**
 * recompute `images.publishedRefCount` from the current public catalog: for each
 * image, the number of PUBLISHED products/overstock documents that reference it.
 * Scope comes from `PUBLIC_CATALOG_COLLECTIONS`, shared with routing and online
 * counter maintenance. Legacy image counters are set to their tally (0 when
 * unreferenced); duplicate ids within one document count once. Images with a
 * publication reference ledger are reported as skipped and cannot be reset here.
 *
 * This is the canonical reconciliation for MIU-04 (design §20.6 step 5): it
 * repairs drift from the non-transactional maintenance path and initialises rows
 * that never went through it (e.g. seeded data). With `dryRun`, it computes and
 * reports the changes without writing. Runs against whatever adapter is wired,
 * so it serves both the local seed and a deployed (CloudBase) invocation.
 *
 * Run during a quiescent window: it writes ABSOLUTE counts, so a live increment
 * (Phase B maintenance) landing between this function's read and its write can be
 * transiently clobbered. A one-shot admin invocation still requires that window;
 * the write-time ledger guard only prevents overwriting managed reference state.
 */
export async function backfillPublishedRefCounts(
  opts: { dryRun?: boolean } = {},
): Promise<BackfillRefCountsReport> {
  const dryRun = opts.dryRun ?? false;
  const catalogCollections = PUBLIC_CATALOG_COLLECTIONS;

  // Tally published references per image id.
  const counts = new Map<string, number>();
  for (const collection of catalogCollections) {
    let page = 1;
    for (;;) {
      const res = await list({
        collection,
        page,
        pageSize: BACKFILL_PAGE_SIZE,
        search: '',
        filter: { combinator: 'and', clauses: [{ field: 'published', op: 'eq', value: true }] },
        sort: STABLE_PAGE_SORT,
      });
      for (const doc of res.items) {
        const ids = new Set(catalogReferencedImageIds(doc));
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      if (res.items.length === 0 || page * res.pageSize >= res.total) break;
      page += 1;
    }
  }

  // Set every image's counter to its tally.
  const changes: BackfillRefCountsReport['changes'] = [];
  const skipped: NonNullable<BackfillRefCountsReport['skipped']> = [];
  let imagesScanned = 0;
  let page = 1;
  for (;;) {
    const res = await list({
      collection: 'images',
      page,
      pageSize: BACKFILL_PAGE_SIZE,
      search: '',
      sort: STABLE_PAGE_SORT,
    });
    for (const image of res.items) {
      imagesScanned += 1;
      const id = String(image._id);
      if (Object.hasOwn(image, 'catalogPublishedReferenceLedger')) {
        skipped.push({ imageId: id, reason: 'managed-references' });
        continue;
      }
      const to = counts.get(id) ?? 0;
      const from = typeof image.publishedRefCount === 'number' ? image.publishedRefCount : null;
      if (from !== to) {
        if (!dryRun) {
          try {
            const updated = await updateDoc('images', id, { publishedRefCount: to });
            if (!updated || Object.hasOwn(updated, 'catalogPublishedReferenceLedger')) {
              skipped.push({ imageId: id, reason: updated ? 'managed-references' : 'missing' });
              continue;
            }
          } catch (error) {
            if (!isImageReferenceWriteConflict(error)) throw error;
            skipped.push({ imageId: id, reason: 'managed-references' });
            continue;
          }
        }
        changes.push({ imageId: id, from, to });
      }
    }
    if (res.items.length === 0 || page * res.pageSize >= res.total) break;
    page += 1;
  }

  return { dryRun, imagesScanned, changes, ...(skipped.length ? { skipped } : {}) };
}

/** Must run under the image mutex, before ordinary reference scans. */
export async function preparationUsingImage(imageId: string): Promise<string | null> {
  const adapter = db();
  return findCatalogPreparationImageHold(
    { get: (collection, id) => adapter.get(collection, id), list: (query) => adapter.list(query) },
    imageId,
    Date.now(),
    readCatalogPreparationJob,
  );
}
