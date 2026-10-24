import { createHash } from 'node:crypto';
import {
  buildCompleteCatalogPreparationPlan,
  orderedCatalogMedia,
} from '@vibelingan-channel/catalog-import/detail-candidate';
import {
  type CatalogSourceObservation,
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { buildStructuredContent } from '@vibelingan-channel/catalog-import/structured-content';
import {
  type OwnedApprovalCandidate,
  type OwnedApprovalCandidateReader,
  alibabaLinkRevision,
  get,
  list,
  persistCatalogDetailApproval,
} from '@vibelingan-channel/db';
import { prepareCatalogApprovalPlan } from '@vibelingan-channel/db/catalog-detail-commit';
import {
  approvalProductFingerprint,
  catalogStagedApprovalCapacityIssues,
  projectManualSourceProduct,
} from '@vibelingan-channel/db/catalog-detail-staging';
import {
  primarySourceLinkSnapshot,
  sourceBindingSnapshot,
} from '@vibelingan-channel/db/catalog-source-binding';
import {
  SourcePageSchema,
  projectCatalogSourceProduct,
  projectCatalogSourceVariantRow,
  sourceDigest,
  sourceGalleryDigest,
} from '@vibelingan-channel/db/catalog-source-staging';
import { sourcePhotoLookupUrl } from '@vibelingan-channel/db/catalog-supplier-review';
import {
  type CollectionDoc,
  isProductFamily,
  readAlibabaPhotoFailure,
} from '@vibelingan-channel/shared';
import {
  CATALOG_DETAIL_VARIANT_MAX_COUNT,
  catalogVariantCapacityIssues,
} from '@vibelingan-channel/shared/catalog-detail-approval';
import {
  CATALOG_DETAIL_PAGE_MAX_BYTES,
  planCatalogDetailPagination,
} from '@vibelingan-channel/shared/catalog-detail-pagination';
import {
  CatalogIssueSchema,
  CatalogValidationError,
  catalogFailureIssue,
  catalogIssuesFromZod,
} from '@vibelingan-channel/shared/catalog-issues';
import { ConfigurationPhotosSchema } from '@vibelingan-channel/shared/catalog-supplier-review';
import { z } from 'zod';
import { catalogValidationFailure } from './catalog-validation.ts';

const command = z
  .object({
    action: z.literal('prepare'),
    productId: z.string().trim().min(1).max(200),
    page: z.number().int().min(0).max(499).default(0),
  })
  .strict();
/**
 * Stable configuration ids: the same product, source and source variant always
 * get the same id, so an approved configuration and today's candidate line up.
 */
export function sourceVariantIds(
  productId: string,
  sourceKey: string,
  observation: CatalogSourceObservation,
): Map<string, string> {
  return new Map(
    observation.variants.map((v) => {
      const hash = createHash('sha256')
        .update(JSON.stringify(['alibaba', productId, sourceKey, v.sourceVariantKey]))
        .digest('hex');
      return [
        v.sourceVariantKey,
        `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      ];
    }),
  );
}

/** The category fact label a candidate gets for the product's family. */
export function catalogCategoryLabel(productFamily: unknown): { categoryLabel?: string } {
  return isProductFamily(productFamily)
    ? {
        categoryLabel: {
          headphones: 'Headphones',
          'ai-gadgets': 'AI Gadgets',
          toys: 'Toys',
          misc: 'Misc',
        }[productFamily],
      }
    : {};
}

/** Our stored binding for a supplier photo; lookup never fetches it. */
export async function sourceLinkImageId(url: string): Promise<string | undefined> {
  return (await sourceLinkPhoto(url))?.imageId;
}

function sourcePhotoBinding(link: CollectionDoc | null, sourceUrl: string) {
  if (
    link?._id !== sourceMediaLinkId('alibaba', sourceUrl) ||
    link.provider !== 'alibaba' ||
    link.sourceUrl !== sourceUrl
  )
    return null;
  const failure = readAlibabaPhotoFailure(link, Date.now());
  const receipt = link.mediaImportReceipt;
  return {
    imageId: typeof link.imageId === 'string' ? link.imageId : undefined,
    completedOperationId:
      receipt &&
      typeof receipt === 'object' &&
      Reflect.get(receipt, 'imageId') === link.imageId &&
      typeof Reflect.get(receipt, 'operationId') === 'string'
        ? String(Reflect.get(receipt, 'operationId'))
        : null,
    failureRecorded: failure.recorded,
    unavailable: failure.state === 'unusable',
  };
}
async function sourceLinkPhoto(url: string) {
  const sourceUrl = sourcePhotoLookupUrl(url);
  return sourcePhotoBinding(
    await get('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl)),
    sourceUrl,
  );
}
async function sourceLinkPhotos(urls: readonly string[], canRead: () => boolean = () => true) {
  const bindings = new Map<string, ReturnType<typeof sourcePhotoBinding>>();
  for (let offset = 0; offset < urls.length; offset += 100) {
    if (!canRead()) return undefined;
    const batch = urls.slice(offset, offset + 100).map((url) => {
      const sourceUrl = sourcePhotoLookupUrl(url);
      return { url, sourceUrl, id: sourceMediaLinkId('alibaba', sourceUrl) };
    });
    const ids = [...new Set(batch.map((entry) => entry.id))];
    const rows = await list({
      collection: 'catalogSourceLinks',
      page: 1,
      pageSize: 100,
      sort: [{ field: '_id', dir: 'asc' }],
      filter: { combinator: 'and', clauses: [{ field: '_id', op: 'in', value: ids }] },
    });
    if (!canRead()) return undefined;
    const byId = new Map(
      rows.items.filter((row) => ids.includes(row._id)).map((row) => [row._id, row]),
    );
    for (const entry of batch)
      bindings.set(entry.url, sourcePhotoBinding(byId.get(entry.id) ?? null, entry.sourceUrl));
  }
  return bindings;
}

export async function prepareCatalogSource(actorId: string, input: unknown) {
  return prepareSourcePage(actorId, input);
}

type CompleteSourcePlan = Extract<
  Awaited<ReturnType<typeof readCompleteAlibabaDetailPlan>>,
  { ok: true }
>;
interface PreparationScope {
  cached: { actorId: string; productId: string; plan: CompleteSourcePlan } | undefined;
  reuseFirstPage?: boolean;
  capture?: (actorId: string, productId: string, candidate: OwnedApprovalCandidate) => void;
}

/** Reuse a source snapshot only within one server request; every page still has native CAS. */
export function createCatalogSourcePreparer() {
  const scope: PreparationScope = { cached: undefined };
  return (actorId: string, input: unknown) => prepareSourcePage(actorId, input, scope);
}

async function prepareSourcePage(
  actorId: string,
  input: unknown,
  scope?: PreparationScope,
  canRead: () => boolean = () => true,
) {
  const missing = { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  if (!canRead()) return missing;
  const parsed = command.safeParse(input);
  if (!parsed.success)
    return catalogValidationFailure(
      'source-candidate',
      catalogIssuesFromZod(parsed.error.issues, input, { stage: 'commit', remedy: 'reload' }),
    );
  const { productId, page } = parsed.data;
  let complete: CompleteSourcePlan;
  if (
    scope?.cached?.actorId === actorId &&
    scope.cached.productId === productId &&
    (page > 0 || scope.reuseFirstPage)
  ) {
    complete = scope.cached.plan;
  } else {
    if (scope) scope.cached = undefined;
    const product = await get('products', productId);
    if (!canRead()) return missing;
    if (!product) return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
    if (product.archived === true) return { ok: false as const, code: 'CONFLICT' as const };
    const sourceKey = product.alibabaPrimarySourceKey;
    if (typeof sourceKey !== 'string' || sourceKey === '') {
      const issue = await manualConfigurationIssue(productId, canRead);
      if (issue) return issue;
      return persistCatalogDetailApproval(actorId, {
        action: 'manual-source',
        productId,
        configurationRowIds: [],
      });
    }
    const planned = await readCompleteAlibabaDetailPlan(
      productId,
      product,
      (candidate) => scope?.capture?.(actorId, productId, candidate),
      canRead,
    );
    if (!planned.ok) return planned;
    complete = planned;
    if (scope) scope.cached = { actorId, productId, plan: complete };
  }
  const planned = sourcePlanPage(complete, page, 20);
  if (!planned.ok) return planned;
  const { packet } = planned;
  const sourcePage = SourcePageSchema.safeParse(packet);
  if (!sourcePage.success)
    return catalogValidationFailure(
      'source-page',
      catalogIssuesFromZod(sourcePage.error.issues, packet, {
        stage: 'source',
        remedy: 'system-repair',
      }),
    );
  if (!canRead()) return missing;
  const result = await persistCatalogDetailApproval(actorId, sourcePage.data);
  if (scope && (!result.ok || ('complete' in result && result.complete))) scope.cached = undefined;
  return !result.ok && result.code === 'VALIDATION_ERROR'
    ? result.validation
      ? result
      : catalogValidationFailure('source-persistence', [catalogFailureIssue('INTERNAL_ERROR')])
    : result;
}

/** Source validation and website projection only; no identities, media imports or staging writes. */
export async function readAlibabaDetailPlan(
  productId: string,
  product: CollectionDoc,
  page: number,
  pageSize: number,
) {
  const complete = await readCompleteAlibabaDetailPlan(productId, product);
  return complete.ok ? sourcePlanPage(complete, page, pageSize) : complete;
}

export async function readCompleteAlibabaDetailPlan(
  productId: string,
  product: CollectionDoc,
  capture?: (candidate: OwnedApprovalCandidate) => void,
  canRead: () => boolean = () => true,
) {
  const missing = { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  if (!canRead()) return missing;
  const generation = SourcePageSchema.shape.contentGeneration.safeParse(
    product.catalogContentGeneration ?? undefined,
  );
  if (!generation.success)
    return catalogValidationFailure(
      'source-candidate',
      catalogIssuesFromZod(generation.error.issues, product.catalogContentGeneration, {
        stage: 'commit',
        remedy: 'system-repair',
        prefix: ['catalogContentGeneration'],
      }),
    );
  const sourceKey = product.alibabaPrimarySourceKey;
  if (typeof sourceKey !== 'string' || sourceKey === '')
    return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  const observationId = sourceObservationDocumentId('alibaba', sourceKey);
  const row = await get('catalogSourceObservations', observationId);
  if (!canRead()) return missing;
  const normalized = await get('alibabaSourceProducts', sourceKey);
  if (!canRead()) return missing;
  if (!normalized || row?.active === false)
    return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  const snapshot = sourceBindingSnapshot(normalized, row);
  if (!snapshot.ok) {
    if (row) {
      const checked = validateCatalogSourceObservation(row.observation);
      if (!checked.ok) return catalogValidationFailure('source-candidate', checked.issues);
    }
    return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  }
  const primaryLink = primarySourceLinkSnapshot(
    normalized,
    await get('alibabaProductLinks', sourceKey),
    productId,
  );
  if (!canRead()) return missing;
  if (!primaryLink.ok) return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  const chosen = ConfigurationPhotosSchema.safeParse(product.configurationPhotos ?? {});
  if (!chosen.success)
    return catalogValidationFailure(
      'source-candidate',
      catalogIssuesFromZod(chosen.error.issues, product.configurationPhotos, {
        stage: 'effective-content',
        remedy: 'edit',
        prefix: ['configurationPhotos'],
      }),
    );
  const observation = snapshot.observation;
  const gallery = new Set(Array.isArray(product.imageIds) ? product.imageIds : []);
  for (const id of Array.isArray(product.descriptionImageIds) ? product.descriptionImageIds : [])
    gallery.add(id);
  const images = new Map<string, string>();
  const linked = new Map<string, string>();
  const configurationFailures: { sourceUrl: string; unavailable: boolean }[] = [];
  const variantUrls = new Set(observation.variants.flatMap((v) => v.media.map((m) => m.sourceUrl)));
  // General images must be attached to this product. SKU-only images instead
  // require an exact mapping in this product's source observation and an owned link.
  const urls = [
    ...new Set(
      [
        ...observation.content.media,
        ...observation.variants.flatMap((v) => v.media),
        ...(observation.content.description?.imageUrls ?? []).map((sourceUrl) => ({ sourceUrl })),
      ].map((m) => m.sourceUrl),
    ),
  ];
  const bindings = await sourceLinkPhotos(urls, canRead);
  if (!bindings || !canRead()) return missing;
  for (const url of urls) {
    const binding = bindings.get(url);
    const imageId = binding?.imageId;
    if (imageId === undefined) {
      if (binding?.failureRecorded && variantUrls.has(url))
        configurationFailures.push({ sourceUrl: url, unavailable: binding.unavailable });
      continue;
    }
    linked.set(url, imageId);
    if (gallery.has(imageId) || variantUrls.has(url)) images.set(url, imageId);
  }
  // Our image ids for the supplier's photos as an import would add them (first
  // N distinct URLs, in order); null while any is not imported (MIU-39).
  const linkedIds = (media: readonly { sourceUrl: string }[], limit: number) => {
    const urls = [...new Set(media.map((m) => m.sourceUrl))].slice(0, limit);
    const ids = urls.map((url) => linked.get(url));
    return ids.every((value): value is string => value !== undefined) ? ids : null;
  };
  const variants = sourceVariantIds(productId, sourceKey, observation);
  const candidate = buildCompleteCatalogPreparationPlan(observation, {
    productId,
    variants,
    images,
    websiteProduct: { ...product, detailSourceOwner: `alibaba:${sourceKey}` },
    ...catalogCategoryLabel(product.productFamily),
  });
  if (!candidate.ok) return catalogValidationFailure('source-candidate', candidate.issues);
  const { variants: allVariants } = candidate.value;
  const header = candidate.sourceHeader;
  // The admin's photo choice for a configuration replaces the supplier's
  // photos (DEC-20); only photos in this product's gallery count.
  const galleryIds = new Set(Array.isArray(product.imageIds) ? product.imageIds : []);
  const choiceFor = (variantId: string) => {
    const picked = (chosen.data[variantId] ?? []).filter((id) => galleryIds.has(id));
    return picked.length > 0 ? picked : undefined;
  };
  for (const variant of allVariants) {
    const picked = choiceFor(variant.id);
    if (picked) variant.images = picked.map((id) => `/api/images/${id}`);
  }
  const capacity = catalogVariantCapacityIssues(allVariants);
  if (capacity.length)
    return catalogValidationFailure(
      'source-candidate',
      capacity.map((issue) => ({ ...issue, remedy: 'edit' as const })),
    );
  const structured =
    candidate.value.header.descriptionText === header.descriptionText
      ? buildStructuredContent(observation.content.description)
      : { content: undefined, noteBlocks: undefined };
  const variantMedia = observation.variants.map((variant) => {
    const id = variants.get(variant.sourceVariantKey);
    if (!id) throw new Error('Canonical variant binding changed during source preparation');
    const selected = orderedCatalogMedia(variant.media).slice(0, 9);
    return {
      id,
      sources: selected.map((media) => media.sourceUrl),
      unboundSources: choiceFor(id)
        ? []
        : selected.filter((media) => !images.has(media.sourceUrl)).map((media) => media.sourceUrl),
    };
  });
  const mediaOrderChanged = variantMedia.some((media, index) =>
    media.sources.some(
      (url, position) => observation.variants[index]?.media[position]?.sourceUrl !== url,
    ),
  );
  const observationDigest = sourceDigest(row?.observation);
  const galleryDigest = sourceGalleryDigest(product);
  const revision = sourceDigest([
    observationDigest,
    { ...snapshot.expectation, linkHash: primaryLink.linkHash },
    galleryDigest,
    [...images].sort(),
    [...variants],
    structured.content ?? null,
    structured.noteBlocks ?? null,
    // Invalidate old prepared rows only when their raw prefix had a different meaning.
    ...(mediaOrderChanged
      ? ['catalog-variant-media-order-v1', variantMedia.map((media) => media.sources)]
      : []),
    ...(product.catalogContentGeneration === undefined
      ? []
      : ['content-generation', product.catalogContentGeneration]),
  ]);
  const packet = {
    action: 'source-page',
    productId,
    sourceKey,
    observationId,
    observationDigest,
    expectedBinding: { ...snapshot.expectation, linkHash: primaryLink.linkHash },
    galleryDigest,
    ...(generation.data === undefined ? {} : { contentGeneration: generation.data }),
    revision,
    header,
    content: structured.content ?? null,
    noteBlocks: structured.noteBlocks ?? null,
    variantIds: [...variants.values()],
    variants: allVariants,
    supplierMedia: {
      gallery: linkedIds(
        [...observation.content.media].sort((a, b) => a.position - b.position),
        9,
      ),
      descriptionImages: linkedIds(
        (observation.content.description?.imageUrls ?? []).map((sourceUrl) => ({ sourceUrl })),
        18,
      ),
    },
    variantMedia,
  };
  let approvalPlan: ReturnType<typeof prepareCatalogApprovalPlan>['plan'];
  try {
    // Native source pages parse these fields before storing them. Keep identical
    // schema order here because approval fingerprints and page hashes use JSON.
    const canonical = SourcePageSchema.safeParse({
      ...packet,
      page: Math.max(1, Math.ceil(packet.variantIds.length / 20)) - 1,
      variants: [],
      variantMedia: [],
    });
    if (!canonical.success)
      return catalogValidationFailure(
        'source-page',
        catalogIssuesFromZod(canonical.error.issues, packet, {
          stage: 'source',
          remedy: 'system-repair',
        }),
      );
    const canonicalPacket = canonical.data;
    const stagedProduct = projectCatalogSourceProduct(product, canonicalPacket, row?.observation);
    const mediaById = new Map(packet.variantMedia.map((media) => [media.id, media]));
    const stagedRows = packet.variants.map((variant, position) =>
      projectCatalogSourceVariantRow(
        null,
        canonicalPacket,
        position,
        SourcePageSchema.shape.variants.element.parse(variant),
        mediaById.get(variant.id),
      ),
    );
    const effective = prepareCatalogApprovalPlan(stagedProduct, stagedRows);
    approvalPlan = effective.plan;
    const capacity = catalogStagedApprovalCapacityIssues(stagedProduct, effective.plan);
    if (capacity.length) return catalogValidationFailure('source-candidate', capacity);
    const linkRevision = alibabaLinkRevision(product);
    if (linkRevision === null) return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
    if (!canRead()) return missing;
    capture?.({
      product: stagedProduct,
      rows: stagedRows,
      source: {
        key: sourceKey,
        linkRevision,
        sourceHash: packet.expectedBinding.sourceHash,
        observationHash: packet.expectedBinding.observationHash,
        linkHash: packet.expectedBinding.linkHash,
      },
    });
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return catalogValidationFailure('source-candidate', error.issues);
    throw error;
  }
  return {
    ok: true as const,
    packet,
    approvalPlan,
    detail: candidate.value,
    sourceMedia: {
      configurationPhotos: [
        ...new Map(
          variantMedia.flatMap((media) =>
            choiceFor(media.id)
              ? []
              : media.sources.map(
                  (sourceUrl) =>
                    [
                      sourceUrl,
                      {
                        sourceUrl,
                        imageId: images.get(sourceUrl) ?? null,
                        completedOperationId: bindings.get(sourceUrl)?.completedOperationId ?? null,
                      },
                    ] as const,
                ),
          ),
        ).values(),
      ].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl)),
      configurationFailures: configurationFailures.sort((a, b) =>
        a.sourceUrl.localeCompare(b.sourceUrl),
      ),
      gallerySources: [
        ...new Set(
          [...observation.content.media]
            .sort((a, b) => a.position - b.position)
            .map((media) => media.sourceUrl),
        ),
      ].slice(0, 9),
      descriptionSources: [...new Set(observation.content.description?.imageUrls ?? [])].slice(
        0,
        18,
      ),
    },
  };
}

/** Readonly paging uses the complete plan and the same media metadata returned to the browser. */
export async function readAlibabaDetailPreviewPlan(
  productId: string,
  product: CollectionDoc,
  page: number,
) {
  const complete = await readCompleteAlibabaDetailPlan(productId, product);
  if (!complete.ok) return complete;
  const pagination = catalogSourcePreviewPagination(complete, product);
  return pagination.ok ? sourcePlanPage(complete, page, pagination.pageSize) : pagination;
}

/** Reuse the actual Preview wire check without rebuilding or reading the source twice. */
export function catalogSourcePreviewPagination(
  complete: CompleteSourcePlan,
  product: CollectionDoc,
) {
  const pagination = planCatalogDetailPagination(
    complete.approvalPlan.publication,
    complete.approvalPlan.variants,
    {
      galleryIds: Array.isArray(product.imageIds)
        ? product.imageIds.filter((v): v is string => typeof v === 'string')
        : [],
      descriptionIds: Array.isArray(product.descriptionImageIds)
        ? product.descriptionImageIds.filter((v): v is string => typeof v === 'string')
        : [],
      gallerySources: complete.sourceMedia.gallerySources,
      descriptionSources: complete.sourceMedia.descriptionSources,
      variantSources: complete.packet.variantMedia,
    },
  );
  if (!pagination.singlePageFits)
    return catalogValidationFailure('source-candidate', [
      CatalogIssueSchema.parse({
        code: 'TOO_LARGE',
        stage: 'media',
        path: 'data',
        severity: 'error',
        remedy: 'system-repair',
        expected: { maxBytes: CATALOG_DETAIL_PAGE_MAX_BYTES },
        observed: { bytes: pagination.pageBytesBound },
      }),
    ]);
  return { ok: true as const, pageSize: pagination.pageSize };
}

function sourcePlanPage(complete: CompleteSourcePlan, page: number, pageSize: number) {
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    !Number.isSafeInteger(page * pageSize)
  )
    return catalogValidationFailure('source-candidate', [
      CatalogIssueSchema.parse({
        code: 'INVALID_VALUE',
        stage: 'effective-content',
        path: 'page',
        severity: 'error',
        remedy: 'reload',
      }),
    ]);
  const offset = page * pageSize;
  const variants = complete.detail.variants;
  return {
    ...complete,
    packet: {
      ...complete.packet,
      page,
      variants: complete.packet.variants.slice(offset, offset + pageSize),
      variantMedia: complete.packet.variantMedia.slice(offset, offset + pageSize),
    },
    detail: {
      ...complete.detail.header,
      variants: {
        items: variants.slice(offset, offset + pageSize),
        page: page + 1,
        pageSize,
        total: variants.length,
        hasMore: offset + pageSize < variants.length,
      },
    },
  };
}

async function manualConfigurationIssue(productId: string, canRead: () => boolean = () => true) {
  for (let page = 1; page <= 100; page++) {
    if (!canRead()) return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
    const rows = await list({
      collection: 'productVariants',
      page,
      pageSize: 100,
      filter: {
        combinator: 'and',
        clauses: [
          { field: 'productId', op: 'eq', value: productId },
          { field: 'archived', op: 'ne', value: true },
        ],
      },
    });
    if (!canRead()) return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
    if (rows.total > CATALOG_DETAIL_VARIANT_MAX_COUNT)
      return catalogValidationFailure('source-candidate', [
        CatalogIssueSchema.parse({
          code: 'TOO_MANY',
          stage: 'effective-content',
          path: 'variants.items',
          severity: 'error',
          remedy: 'system-repair',
          expected: { maxCount: CATALOG_DETAIL_VARIANT_MAX_COUNT },
          observed: { count: rows.total },
        }),
      ]);
    const manualRow = rows.items.some(
      (row) =>
        !(
          typeof row.detailSourceOwner === 'string' && row.detailSourceOwner.startsWith('alibaba:')
        ),
    );
    if (manualRow) return { ok: false as const, code: 'MANUAL_CONFIGURATIONS' as const };
    if (rows.items.length === 0 || page * 100 >= rows.total) break;
  }
  return null;
}

/** One request owns both the source page plan and its private, canonical approval candidate. */
export function createOwnedCatalogSourcePreparer() {
  let memo: { actorId: string; productId: string; candidate: OwnedApprovalCandidate } | undefined;
  const scope: PreparationScope = {
    cached: undefined,
    reuseFirstPage: true,
    capture: (actorId, productId, candidate) => {
      memo = { actorId, productId, candidate };
    },
  };
  const readCandidate: OwnedApprovalCandidateReader = async (actorId, productId, canRead) => {
    const missing = { ok: false as const, code: 'SOURCE_NOT_READY' as const };
    if (!canRead()) return missing;
    const product = await get('products', productId);
    if (!canRead()) return missing;
    if (!product) return { ok: false, code: 'NOT_FOUND' };
    if (product.archived === true) return { ok: false, code: 'CONFLICT' };
    if (memo?.actorId !== actorId || memo.productId !== productId) {
      memo = undefined;
      scope.cached = undefined;
      if (
        typeof product.alibabaPrimarySourceKey !== 'string' ||
        product.alibabaPrimarySourceKey === ''
      ) {
        const issue = await manualConfigurationIssue(productId, canRead);
        if (!canRead()) return missing;
        if (issue) return issue.code === 'MANUAL_CONFIGURATIONS' ? missing : issue;
        const projected = projectManualSourceProduct(product);
        if (!projected) return { ok: false, code: 'VALIDATION_ERROR' };
        memo = {
          actorId,
          productId,
          candidate: { product: projected.product, rows: [], source: null },
        };
      } else {
        const planned = await readCompleteAlibabaDetailPlan(
          productId,
          product,
          (candidate) => scope.capture?.(actorId, productId, candidate),
          canRead,
        );
        if (!planned.ok) return planned;
        scope.cached = { actorId, productId, plan: planned };
      }
    }
    if (!canRead()) return missing;
    const current = await get('products', productId);
    if (!canRead()) return missing;
    const candidate = memo?.candidate;
    if (
      !candidate ||
      !current ||
      approvalProductFingerprint(current) !== approvalProductFingerprint(candidate.product)
    )
      return missing;
    return { ok: true, ...candidate };
  };
  return {
    readCandidate,
    prepare: async (actorId: string, input: unknown, canRead: () => boolean = () => true) => {
      const result = await prepareSourcePage(actorId, input, scope, canRead);
      if (!result.ok) {
        memo = undefined;
        scope.cached = undefined;
      }
      return result;
    },
  };
}
