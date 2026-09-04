/**
 * Persistence for the provider-neutral catalog import.
 *
 * Two ideas carry the whole file.
 *
 * DETERMINISTIC IDS. Every record this pipeline writes has an id derived from
 * the source, so re-running an import addresses the same rows instead of
 * creating new ones. A retry after a crash — or a merchant uploading the same
 * export twice — cannot produce a duplicate product, variant, link, job or
 * staged item.
 *
 * LINK FIRST, THEN THE THING IT NAMES. Channel product and variant ids are
 * independent of the provider (a Channel product is not a Dianxiaomi object),
 * so they cannot be derived from a source key. Instead the canonical LINK row
 * is created first, using create-if-absent, and it carries the Channel id it
 * won. If two runs race, one loses the create and adopts the winner's id; if a
 * run dies between the link and the product, the retry reads its own id back
 * out of the link rather than minting a second one.
 */
import { randomUUID } from 'node:crypto';
import {
  type CatalogImportDetail,
  type CatalogObservationFinding,
  type CatalogProductCandidate,
  type CatalogSourceObservation,
  type StoreListingRecord,
  displayQuantity,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import';
import { dianxiaomiObservationAdapter } from '@vibelingan-channel/catalog-import/dianxiaomi';
import {
  createDocWithId,
  findByField,
  get,
  list,
  updateDoc,
  upsertDocWithId,
} from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';

export const IMPORT_JOBS = 'catalogImportJobs';
export const IMPORT_ITEMS = 'catalogImportItems';
export const SOURCE_LINKS = 'catalogSourceLinks';
export const PRODUCT_VARIANTS = 'productVariants';
export const CATEGORY_MAPPINGS = 'sourceCategoryMappings';

/** Fields on `products` that belong to the Alibaba sync and to nothing else. */
export const ALIBABA_OWNED_PRODUCT_FIELDS: readonly string[] = [
  'alibabaPrimarySourceKey',
  'alibabaPrimaryOfferKey',
  'alibabaPinnedOfferKey',
  'alibabaCatalogPricing',
  'alibabaSourceStatus',
  'alibabaSourceLastSyncedAt',
] as const;

/**
 * Guard, not documentation. Any write this pipeline makes to `products` passes
 * through here first, so "the importer must never touch Alibaba fields" is
 * enforced at one seam rather than asserted in a comment at six call sites.
 */
export function assertNoAlibabaFields(patch: Record<string, unknown>, context: string): void {
  for (const field of ALIBABA_OWNED_PRODUCT_FIELDS) {
    if (Object.hasOwn(patch, field)) {
      throw new Error(`${context}: catalog import must never write ${field}`);
    }
  }
  for (const key of Object.keys(patch)) {
    if (key.startsWith('alibaba')) {
      throw new Error(`${context}: catalog import must never write ${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * A job is identified by what it read. The first import of a file is
 * `<provider>:<sha256>`; an explicit replay appends an attempt suffix, so a
 * replay is a new job with its own audit trail rather than an overwrite of the
 * original.
 */
export function importJobId(provider: string, sha256: string, attempt = 0): string {
  return attempt === 0 ? `${provider}:${sha256}` : `${provider}:${sha256}:r${attempt}`;
}

export function importItemId(jobId: string, candidateGroupKey: string): string {
  return `${jobId}#${candidateGroupKey}`;
}

export function groupLinkId(candidateGroupKey: string): string {
  return `group:${candidateGroupKey}`;
}

export function variantLinkId(candidateSkuKey: string): string {
  return `variant:${candidateSkuKey}`;
}

export function storeLinkId(sourceVariantKey: string): string {
  return `store:${sourceVariantKey}`;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface StartImportJobInput {
  provider: string;
  sourceFileName: string;
  sourceFileSha256: string;
  sourceByteSize: number;
  settings?: Record<string, unknown>;
  /** Import the same bytes again as a NEW job instead of reusing the old one. */
  replay?: boolean;
  now: string;
}

export interface StartImportJobResult {
  job: CollectionDoc;
  /**
   * True when this exact file was already imported and the existing job was
   * returned untouched. The caller stops here unless a replay was requested —
   * that is what makes a byte-identical re-import a genuine no-op.
   */
  reused: boolean;
}

export interface ImportSourceEvidence {
  storageFileId: string;
  storagePath: string;
  storageProvider: string;
  storageMode: string;
  contentType: string;
}

/** Attach the immutable private source object to its deterministic base job. */
export async function recordImportSourceEvidence(
  jobId: string,
  evidence: ImportSourceEvidence,
  now: string,
): Promise<CollectionDoc> {
  const updated = await updateDoc(IMPORT_JOBS, jobId, {
    sourceStorageFileId: evidence.storageFileId,
    sourceStoragePath: evidence.storagePath,
    sourceStorageProvider: evidence.storageProvider,
    sourceStorageMode: evidence.storageMode,
    sourceContentType: evidence.contentType,
    sourceEvidenceStoredAt: now,
  });
  if (!updated) throw new Error('import job vanished before source evidence was attached');
  return updated;
}

export async function failImportJobEvidence(jobId: string, now: string): Promise<void> {
  const updated = await updateDoc(IMPORT_JOBS, jobId, {
    status: 'failed',
    failureCode: 'source-evidence-write-failed',
    completedAt: now,
  });
  if (!updated) throw new Error('import job vanished while recording evidence failure');
}

/**
 * Create the job BEFORE parsing, so a workbook that crashes the parser still
 * leaves a record of what was attempted.
 */
export async function startImportJob(input: StartImportJobInput): Promise<StartImportJobResult> {
  const baseId = importJobId(input.provider, input.sourceFileSha256);
  const existing = await get(IMPORT_JOBS, baseId);

  if (existing !== null && input.replay !== true) return { job: existing, reused: true };

  const buildJobDoc = (replayOfJobId: string): Record<string, unknown> => ({
    provider: input.provider,
    status: 'created',
    sourceFileName: input.sourceFileName,
    sourceFileSha256: input.sourceFileSha256,
    sourceByteSize: input.sourceByteSize,
    settings: input.settings ?? {},
    startedAt: input.now,
    ...(replayOfJobId === '' ? {} : { replayOfJobId }),
  });

  if (existing === null) {
    // create-if-absent, not read-then-write: two concurrent first imports of
    // the identical file must converge on ONE job record, not have the second
    // caller's upsert silently overwrite the first's (different settings, a
    // different `now`) without either caller knowing it lost.
    const outcome = await createDocWithId(IMPORT_JOBS, baseId, buildJobDoc(''));
    if (outcome === 'exists') {
      const winner = await get(IMPORT_JOBS, baseId);
      if (winner !== null) return { job: winner, reused: true };
    }
    const job = await get(IMPORT_JOBS, baseId);
    if (job === null) throw new Error('import job vanished immediately after creation');
    return { job, reused: false };
  }

  // Replay: find the next free attempt id via genuine create-if-absent
  // retries, not a check-then-write loop. Two concurrent replays of the same
  // source file must never both "win" the same attempt slot -- a read-then-
  // write loop lets exactly that happen, with the second writer's
  // upsertDocWithId silently clobbering the first's job record.
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = importJobId(input.provider, input.sourceFileSha256, attempt);
    const outcome = await createDocWithId(IMPORT_JOBS, candidate, buildJobDoc(baseId));
    if (outcome === 'created') {
      const job = await get(IMPORT_JOBS, candidate);
      if (job === null) throw new Error('import job vanished immediately after creation');
      return { job, reused: false };
    }
  }
  throw new Error('too many replays of the same source file');
}

export interface JobSummary {
  products: number;
  variants: number;
  storeListings: number;
  quarantined: number;
  errors: number;
  warnings: number;
  inventoryKnown: number;
  inventoryConflict: number;
  inventoryUnknown: number;
}

function summarize(
  detail: CatalogImportDetail,
  observationFindings: readonly CatalogObservationFinding[] = [],
): JobSummary {
  const variants = detail.bundle.products.reduce(
    (total, product) => total + product.variants.length,
    0,
  );
  return {
    products: detail.bundle.products.length,
    variants,
    storeListings: detail.storeListings.length,
    quarantined: detail.quarantined.length,
    errors:
      detail.bundle.findings.filter((finding) => finding.severity === 'error').length +
      observationFindings.filter((finding) => finding.severity === 'error').length,
    warnings:
      detail.bundle.findings.filter((finding) => finding.severity === 'warning').length +
      observationFindings.filter((finding) => finding.severity === 'warning').length,
    inventoryKnown: detail.inventory.filter((entry) => entry.resolution.state === 'known').length,
    inventoryConflict: detail.inventory.filter((entry) => entry.resolution.state === 'conflict')
      .length,
    inventoryUnknown: detail.inventory.filter((entry) => entry.resolution.state === 'unknown')
      .length,
  };
}

/** Item status from its own findings — warnings do not block, errors do. */
function itemStatus(findings: readonly { severity: string }[]): 'valid' | 'warning' | 'rejected' {
  if (findings.some((finding) => finding.severity === 'error')) return 'rejected';
  return findings.length > 0 ? 'warning' : 'valid';
}

/**
 * Persist the parsed bundle: one staged item per product candidate, plus the
 * job's counts, findings and summary. Item ids are deterministic, so running
 * this twice for the same job overwrites rather than duplicates.
 */
export async function recordParsedBundle(
  jobId: string,
  detail: CatalogImportDetail,
  now: string,
): Promise<CollectionDoc> {
  // The workbook parser and the API collector deliberately have different
  // acquisition contracts. They converge only here, after provider data has
  // been normalized and runtime-validated as one product observation.
  const observationBatch = dianxiaomiObservationAdapter.toObservations({
    bundle: detail.bundle,
    storeListings: detail.storeListings,
    evidenceId: jobId,
    observedAt: now,
  });
  const observationsBySourceKey = new Map<string, CatalogSourceObservation>();
  const duplicateObservationKeys = new Set<string>();
  const observationFindings: CatalogObservationFinding[] = [...observationBatch.findings];
  for (const observation of observationBatch.observations) {
    const sourceKey = observation.source.sourceProductKey;
    if (observationsBySourceKey.has(sourceKey) || duplicateObservationKeys.has(sourceKey)) {
      observationFindings.push({
        severity: 'error',
        code: 'duplicate-source-observation',
        message: 'The adapter emitted more than one observation for the same source product.',
        sourcePath: sourceKey,
      });
      observationsBySourceKey.delete(sourceKey);
      duplicateObservationKeys.add(sourceKey);
      continue;
    }
    observationsBySourceKey.set(sourceKey, observation);
  }

  const listingsByGroup = new Map<string, StoreListingRecord[]>();
  for (const listing of detail.storeListings) {
    listingsByGroup.set(listing.candidateGroupKey, [
      ...(listingsByGroup.get(listing.candidateGroupKey) ?? []),
      listing,
    ]);
  }

  const inventoryByKey = new Map(detail.inventory.map((entry) => [entry.candidateSkuKey, entry]));

  for (const candidate of detail.bundle.products) {
    const groupKey = candidate.identity.sourceProductKey;
    const groupListings = listingsByGroup.get(groupKey) ?? [];
    const expectedObservationKeys = [
      ...new Set(
        groupListings.length > 0
          ? groupListings.map((listing) => listing.sourceProductKey)
          : [groupKey],
      ),
    ];
    const skuKeys = new Set(
      candidate.variants.map((variant) => variant.identity.sourceVariantKey ?? ''),
    );
    // A finding belongs to this item when it names one of its SKUs or its
    // parent SKU. Findings that name neither stay on the job.
    const findings = detail.bundle.findings.filter(
      (finding) =>
        (finding.parentSku !== undefined && finding.parentSku === candidate.parentSku) ||
        (finding.sku !== undefined &&
          candidate.variants.some((variant) => variant.sku === finding.sku)),
    );
    const candidateObservationFindings = observationFindings.filter(
      (finding) =>
        finding.sourcePath === groupKey ||
        (finding.sourcePath !== undefined && expectedObservationKeys.includes(finding.sourcePath)),
    );
    const candidateObservations: CatalogSourceObservation[] = [];
    for (const sourceKey of expectedObservationKeys) {
      const observation = observationsBySourceKey.get(sourceKey);
      if (observation) {
        candidateObservations.push(observation);
        continue;
      }
      if (!candidateObservationFindings.some((finding) => finding.sourcePath === sourceKey)) {
        const missingFinding: CatalogObservationFinding = {
          severity: 'error',
          code: 'missing-source-observation',
          message: 'The adapter did not emit a validated observation for this source product.',
          sourcePath: sourceKey,
        };
        candidateObservationFindings.push(missingFinding);
        observationFindings.push(missingFinding);
      }
    }
    const itemFindings = [...findings, ...candidateObservationFindings];

    await upsertDocWithId(IMPORT_ITEMS, importItemId(jobId, groupKey), {
      jobId,
      status: itemStatus(itemFindings),
      candidateGroupKey: groupKey,
      parentSku: candidate.parentSku,
      title: candidate.title,
      sourceListingStatus: candidate.sourceListingStatus,
      variantCount: candidate.variants.length,
      candidate,
      storeListings: groupListings,
      inventory: [...skuKeys]
        .map((key) => inventoryByKey.get(key))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
      findings: itemFindings,
    });

    // Invalid observations are isolated to their staged item. They never reach
    // the current materialized view, and they do not crash unrelated products
    // in the same workbook.
    if (!candidateObservationFindings.some((finding) => finding.severity === 'error')) {
      for (const observation of candidateObservations) {
        const sourceKey = observation.source.sourceProductKey;
        const observationId = sourceObservationDocumentId('dianxiaomi', sourceKey);
        const existingObservation = await get('catalogSourceObservations', observationId);
        await upsertDocWithId('catalogSourceObservations', observationId, {
          provider: 'dianxiaomi',
          sourceProductKey: sourceKey,
          ...(observation.source.externalProductId === undefined
            ? {}
            : { externalProductId: observation.source.externalProductId }),
          schemaVersion: observation.schemaVersion,
          observedAt: observation.source.observedAt,
          ...(observation.source.sourceUpdatedAt === undefined
            ? {}
            : { sourceUpdatedAt: observation.source.sourceUpdatedAt }),
          evidenceId:
            observation.evidence[0]?.evidenceId ??
            `${detail.bundle.provider}:${detail.bundle.sourceFileSha256}`,
          active: observation.lifecycle.sourceListingStatus !== 'missing',
          observation,
          lastSeenOperationId: jobId,
          ...(existingObservation ? {} : { firstSeenOperationId: jobId }),
        });
      }
    }
  }

  const persistedFindings = [
    ...detail.bundle.findings,
    ...observationFindings.map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
      ...(finding.sourcePath === undefined ? {} : { sourcePath: finding.sourcePath }),
    })),
  ];

  const patched = await updateDoc(IMPORT_JOBS, jobId, {
    status: detail.structurallyValid ? 'previewReady' : 'failed',
    templateId: detail.bundle.templateId,
    sheetName: detail.sheetName,
    counts: { ...detail.counts, dataRows: detail.dataRowCount },
    summary: summarize(detail, observationFindings),
    ignoredHeaders: detail.bundle.ignoredHeaders,
    templateHeaders: detail.templateHeaders,
    findings: persistedFindings,
    completedAt: now,
    ...(detail.structurallyValid
      ? {}
      : { errorSummary: persistedFindings.map((finding) => finding.message).join('; ') }),
  });
  if (patched === null) throw new Error(`import job ${jobId} disappeared while recording results`);
  return patched;
}

export async function listImportJobs(limit = 25): Promise<CollectionDoc[]> {
  const page = await list({
    collection: IMPORT_JOBS,
    page: 1,
    pageSize: limit,
    sort: [{ field: 'startedAt', dir: 'desc' }],
  });
  return page.items;
}

export async function listImportItems(jobId: string, limit = 500): Promise<CollectionDoc[]> {
  const page = await list({
    collection: IMPORT_ITEMS,
    page: 1,
    pageSize: limit,
    filter: { combinator: 'and', clauses: [{ field: 'jobId', op: 'eq', value: jobId }] },
    sort: [{ field: 'parentSku', dir: 'asc' }],
  });
  return page.items;
}

// ---------------------------------------------------------------------------
// Canonical links
// ---------------------------------------------------------------------------

export interface CanonicalBinding {
  /** The Channel id bound to this source key. */
  channelId: string;
  /** True when this call created the binding rather than adopting one. */
  created: boolean;
}

/**
 * Bind a source key to a Channel id, exactly once, forever.
 *
 * `createDocWithId` is a single-winner create-if-absent, so concurrent callers
 * and retries converge on one id. The Channel id itself is a fresh UUID: no
 * provider owns Channel identity, and deriving it from a source key would make
 * the same SKU arriving from a second provider look like the same product.
 */
async function bindCanonical(
  docId: string,
  seed: Record<string, unknown>,
  now: string,
): Promise<CanonicalBinding> {
  const channelId = randomUUID();
  const outcome = await createDocWithId(SOURCE_LINKS, docId, {
    ...seed,
    ...(seed.linkKind === 'group' ? { productId: channelId } : { variantId: channelId }),
    lastSeenAt: now,
  });
  if (outcome === 'created') return { channelId, created: true };

  const existing = await get(SOURCE_LINKS, docId);
  const bound = seed.linkKind === 'group' ? existing?.productId : existing?.variantId;
  if (typeof bound !== 'string' || bound === '') {
    throw new Error(`source link ${docId} exists without a Channel id`);
  }
  return { channelId: bound, created: false };
}

export function bindProduct(
  candidateGroupKey: string,
  candidate: CatalogProductCandidate,
  now: string,
): Promise<CanonicalBinding> {
  return bindCanonical(
    groupLinkId(candidateGroupKey),
    {
      linkKind: 'group',
      provider: candidate.identity.provider,
      taxonomy: '',
      storeKey: '',
      sourceProductKey: candidateGroupKey,
      candidateGroupKey,
      parentSku: candidate.parentSku,
      sourceListingStatus: candidate.sourceListingStatus,
    },
    now,
  );
}

export function bindVariant(
  candidateSkuKey: string,
  productId: string,
  provider: string,
  sku: string,
  now: string,
): Promise<CanonicalBinding> {
  return bindCanonical(
    variantLinkId(candidateSkuKey),
    {
      linkKind: 'variant',
      provider,
      taxonomy: '',
      storeKey: '',
      sourceVariantKey: candidateSkuKey,
      candidateSkuKey,
      productId,
      sku,
    },
    now,
  );
}

/** Upsert one store's line. Deterministic id, so a repeat import updates it. */
export function recordStoreLink(
  listing: StoreListingRecord,
  productId: string,
  variantId: string,
  jobId: string,
  now: string,
): Promise<CollectionDoc> {
  return upsertDocWithId(SOURCE_LINKS, storeLinkId(listing.sourceVariantKey), {
    linkKind: 'store',
    provider: listing.provider,
    taxonomy: listing.taxonomy,
    storeKey: listing.storeKey,
    sourceProductKey: listing.sourceProductKey,
    sourceVariantKey: listing.sourceVariantKey,
    candidateGroupKey: listing.candidateGroupKey,
    candidateSkuKey: listing.candidateSkuKey,
    parentSku: listing.parentSku,
    sku: listing.sku,
    productId,
    variantId,
    sourceListingStatus: listing.sourceListingStatus,
    lastSeenJobId: jobId,
    lastSeenAt: now,
    // Seeing the record again clears any earlier missing marker.
    sourceMissingSince: '',
    ...(listing.externalProductId === undefined
      ? {}
      : { externalProductId: listing.externalProductId }),
    ...(listing.externalVariantId === undefined
      ? {}
      : { externalVariantId: listing.externalVariantId }),
    ...(listing.sourceRegularPrice === undefined
      ? {}
      : { sourceRegularPrice: listing.sourceRegularPrice }),
    ...(listing.sourcePromotionPrice === undefined
      ? {}
      : { sourcePromotionPrice: listing.sourcePromotionPrice }),
    ...(listing.quantity === undefined ? {} : { quantity: listing.quantity }),
  });
}

export async function findStoreLink(sourceVariantKey: string): Promise<CollectionDoc | null> {
  return get(SOURCE_LINKS, storeLinkId(sourceVariantKey));
}

export async function listStoreLinksForProvider(
  provider: string,
  limit = 5000,
): Promise<CollectionDoc[]> {
  const page = await list({
    collection: SOURCE_LINKS,
    page: 1,
    pageSize: limit,
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'linkKind', op: 'eq', value: 'store' },
        { field: 'provider', op: 'eq', value: provider },
      ],
    },
  });
  return page.items;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export interface VariantWriteInput {
  variantId: string;
  productId: string;
  sku: string;
  position: number;
  optionValues: Record<string, string>;
  inventory: CatalogImportDetail['inventory'][number] | undefined;
  sourceRegularPrice?: { amountMinor: number; currency: string };
  sourcePromotionPrice?: { amountMinor: number; currency: string };
  imageIds?: string[];
}

/**
 * Write one canonical variant. `inventoryQuantity` is written ONLY when the
 * reconciliation actually produced a number — a conflict or an unknown leaves
 * the field empty rather than storing a guess that later reads as fact.
 */
export function writeVariant(input: VariantWriteInput): Promise<CollectionDoc> {
  const resolution = input.inventory?.resolution;
  const quantity = resolution === undefined ? null : displayQuantity(resolution);
  return upsertDocWithId(PRODUCT_VARIANTS, input.variantId, {
    productId: input.productId,
    sku: input.sku,
    position: input.position,
    optionValues: input.optionValues,
    inventoryState: resolution?.state ?? 'unknown',
    inventorySnapshots: resolution?.snapshots ?? [],
    ...(quantity === null ? { inventoryQuantity: '' } : { inventoryQuantity: quantity }),
    ...(input.sourceRegularPrice === undefined
      ? {}
      : { sourceRegularPrice: input.sourceRegularPrice }),
    ...(input.sourcePromotionPrice === undefined
      ? {}
      : { sourcePromotionPrice: input.sourcePromotionPrice }),
    ...(input.imageIds === undefined ? {} : { imageIds: input.imageIds }),
  });
}

export async function listVariantsForProduct(productId: string): Promise<CollectionDoc[]> {
  const page = await list({
    collection: PRODUCT_VARIANTS,
    page: 1,
    pageSize: 100,
    filter: { combinator: 'and', clauses: [{ field: 'productId', op: 'eq', value: productId }] },
    sort: [{ field: 'position', dir: 'asc' }],
  });
  return page.items;
}

// ---------------------------------------------------------------------------
// Category mappings
// ---------------------------------------------------------------------------

export interface ResolvedCategory {
  productFamily: string;
  channelCategory?: string;
}

/**
 * Resolve a source category to a Channel product family, or `null`.
 *
 * `null` is a real answer and the common one: an unmapped source category
 * means the operator has not decided yet, and publication must not decide for
 * them. The workbook contains toys and phones; quietly filing them under a
 * headphones subcategory would be worse than leaving them unmapped.
 */
export async function resolveCategoryMapping(
  provider: string,
  sourceTaxonomy: string,
  sourceCategoryId: string | undefined,
): Promise<ResolvedCategory | null> {
  if (sourceCategoryId === undefined || sourceCategoryId === '') return null;
  const page = await list({
    collection: CATEGORY_MAPPINGS,
    page: 1,
    pageSize: 1,
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'provider', op: 'eq', value: provider },
        { field: 'sourceTaxonomy', op: 'eq', value: sourceTaxonomy },
        { field: 'sourceCategoryId', op: 'eq', value: sourceCategoryId },
      ],
    },
  });
  const mapping = page.items[0];
  if (mapping === undefined) return null;
  const productFamily = mapping.productFamily;
  if (typeof productFamily !== 'string' || productFamily === '') return null;
  const channelCategory = mapping.channelCategory;
  return {
    productFamily,
    ...(typeof channelCategory === 'string' && channelCategory !== '' ? { channelCategory } : {}),
  };
}

/** Look up a product by an arbitrary field; used by the publish idempotency path. */
export function findProductByField(field: string, value: unknown): Promise<CollectionDoc | null> {
  return findByField('products', field, value);
}
