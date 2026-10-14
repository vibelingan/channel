import { createHash } from 'node:crypto';
import { buildCompleteCatalogPreparationPlan } from '@vibelingan-channel/catalog-import/detail-candidate';
import {
  type CatalogSourceObservation,
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { buildStructuredContent } from '@vibelingan-channel/catalog-import/structured-content';
import { get, list, persistCatalogDetailApproval } from '@vibelingan-channel/db';
import { prepareCatalogApprovalPlan } from '@vibelingan-channel/db/catalog-detail-commit';
import { catalogStagedApprovalCapacityIssues } from '@vibelingan-channel/db/catalog-detail-staging';
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
import { type CollectionDoc, isProductFamily } from '@vibelingan-channel/shared';
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

/** Read the existing observation; approval never invokes Alibaba or downloads media. */
/** Our image id for a supplier photo that was imported, if any. */
export async function sourceLinkImageId(url: string): Promise<string | undefined> {
  const transport = new URL(url);
  if (
    transport.protocol === 'http:' &&
    (transport.hostname === 'alicdn.com' || transport.hostname.endsWith('.alicdn.com'))
  )
    transport.protocol = 'https:';
  const link = await get('catalogSourceLinks', sourceMediaLinkId('alibaba', transport.href));
  return link?.provider === 'alibaba' &&
    link.sourceUrl === transport.href &&
    typeof link.imageId === 'string'
    ? link.imageId
    : undefined;
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
}

/** Reuse a source snapshot only within one server request; every page still has native CAS. */
export function createCatalogSourcePreparer() {
  const scope: PreparationScope = { cached: undefined };
  return (actorId: string, input: unknown) => prepareSourcePage(actorId, input, scope);
}

async function prepareSourcePage(actorId: string, input: unknown, scope?: PreparationScope) {
  const parsed = command.safeParse(input);
  if (!parsed.success)
    return catalogValidationFailure(
      'source-candidate',
      catalogIssuesFromZod(parsed.error.issues, input, { stage: 'commit', remedy: 'reload' }),
    );
  const { productId, page } = parsed.data;
  let complete: CompleteSourcePlan;
  if (scope?.cached?.actorId === actorId && scope.cached.productId === productId && page > 0) {
    complete = scope.cached.plan;
  } else {
    if (scope) scope.cached = undefined;
    const product = await get('products', productId);
    if (!product) return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
    if (product.archived === true) return { ok: false as const, code: 'CONFLICT' as const };
    const sourceKey = product.alibabaPrimarySourceKey;
    if (typeof sourceKey !== 'string' || sourceKey === '') {
      // Manual product (MIU-30): approval reads configuration rows only from the
      // prepare manifest, which is empty here, so manual configuration rows (the
      // Excel import) would be dropped silently. Refuse instead (DESIGN §5.2).
      // Rows left by an earlier Alibaba link are not the admin's and do not block.
      for (let page = 1; page <= 100; page++) {
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
              typeof row.detailSourceOwner === 'string' &&
              row.detailSourceOwner.startsWith('alibaba:')
            ),
        );
        if (manualRow) return { ok: false as const, code: 'MANUAL_CONFIGURATIONS' as const };
        if (rows.items.length === 0 || page * 100 >= rows.total) break;
      }
      return persistCatalogDetailApproval(actorId, {
        action: 'manual-source',
        productId,
        configurationRowIds: [],
      });
    }
    const planned = await readCompleteAlibabaDetailPlan(productId, product);
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

export async function readCompleteAlibabaDetailPlan(productId: string, product: CollectionDoc) {
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
  const normalized = await get('alibabaSourceProducts', sourceKey);
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
  for (let offset = 0; offset < urls.length; offset += 8) {
    await Promise.all(
      urls.slice(offset, offset + 8).map(async (url) => {
        const imageId = await sourceLinkImageId(url);
        if (imageId === undefined) return;
        linked.set(url, imageId);
        if (gallery.has(imageId) || variantUrls.has(url)) images.set(url, imageId);
      }),
    );
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
    variantMedia: observation.variants.map((variant) => {
      const id = variants.get(variant.sourceVariantKey);
      if (!id) throw new Error('Canonical variant binding changed during source preparation');
      return {
        id,
        sources: variant.media.slice(0, 9).map((m) => m.sourceUrl),
        unboundSources: choiceFor(id)
          ? []
          : variant.media
              .slice(0, 9)
              .filter((m) => !images.has(m.sourceUrl))
              .map((m) => m.sourceUrl),
      };
    }),
  };
  let approvalPlan: ReturnType<typeof prepareCatalogApprovalPlan>['plan'];
  try {
    const stagedProduct = projectCatalogSourceProduct(
      product,
      {
        ...packet,
        page: Math.max(1, Math.ceil(packet.variantIds.length / 20)) - 1,
      },
      row?.observation,
    );
    const mediaById = new Map(packet.variantMedia.map((media) => [media.id, media]));
    const stagedRows = packet.variants.map((variant, position) =>
      projectCatalogSourceVariantRow(null, packet, position, variant, mediaById.get(variant.id)),
    );
    const effective = prepareCatalogApprovalPlan(stagedProduct, stagedRows);
    approvalPlan = effective.plan;
    const capacity = catalogStagedApprovalCapacityIssues(stagedProduct, effective.plan);
    if (capacity.length) return catalogValidationFailure('source-candidate', capacity);
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
  return sourcePlanPage(complete, page, pagination.pageSize);
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
