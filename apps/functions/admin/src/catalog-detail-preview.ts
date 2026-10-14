/** Saved-draft projection only. This response cannot authorize or resume an approval. */
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import { get, list } from '@vibelingan-channel/db';
import {
  primarySourceLinkSnapshot,
  sourceBindingSnapshot,
} from '@vibelingan-channel/db/catalog-source-binding';
import { sourceDigest } from '@vibelingan-channel/db/catalog-source-staging';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  decodeCatalogDetailView,
  manualDetailCandidate,
} from '@vibelingan-channel/shared/catalog-detail';
import {
  CATALOG_DETAIL_VARIANT_MAX_COUNT,
  applyWebsiteDetailHeader,
} from '@vibelingan-channel/shared/catalog-detail-approval';
import {
  CatalogIssueSchema,
  CatalogValidationError,
  catalogIssuesFromZod,
} from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import { readAlibabaDetailPreviewPlan } from './catalog-detail-source.ts';
import { catalogValidationFailure } from './catalog-validation.ts';

const commandSchema = z
  .object({
    action: z.literal('preview'),
    productId: z.string().trim().min(1).max(200),
    page: z.number().int().min(1).max(CATALOG_DETAIL_VARIANT_MAX_COUNT).default(1),
    inputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const productFields = [
  '_id',
  'name',
  'description',
  'imageIds',
  'descriptionImageIds',
  'configurationPhotos',
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
  'skuCode',
  'series',
  'modName',
  'modType',
  'catalogContentGeneration',
  'catalogLifecycleVersion',
  'catalogClassificationRevision',
  'catalogDetailPublication',
  'alibabaSourceImageUrls',
  'alibabaDescriptionImageUrls',
];
const productDigest = (product: CollectionDoc) =>
  sourceDigest(productFields.map((field) => [field, product[field] ?? null]));
const admin = (actor: CollectionDoc | null) =>
  actor?.role === 'admin' && actor.status !== 'suspended';
const ids = (urls: readonly string[]) => urls.map((url) => url.slice('/api/images/'.length));

export async function readCatalogDetailPreview(actorId: string, input: unknown) {
  if (!admin(await get('users', actorId)))
    return { ok: false as const, code: 'FORBIDDEN' as const };
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success)
    return catalogValidationFailure(
      'review',
      catalogIssuesFromZod(parsed.error.issues, input, { stage: 'commit', remedy: 'reload' }),
    );
  const { productId, page } = parsed.data;
  const product = await get('products', productId);
  if (!product) return { ok: false as const, code: 'NOT_FOUND' as const };
  if (product.catalogDetailPublication != null) {
    const publication = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
    if (!publication.success)
      return catalogValidationFailure(
        'review',
        catalogIssuesFromZod(publication.error.issues, product.catalogDetailPublication, {
          stage: 'commit',
          remedy: 'system-repair',
        }),
      );
    if (publication.data.header._id !== productId)
      return { ok: false as const, code: 'CONFLICT' as const };
  }
  const initialProductDigest = productDigest(product);
  // Archived drafts are readable; this projection never changes their lifecycle or grants publish permission.
  const projectedProduct = { ...product, archived: false };
  try {
    const sourceKey = product.alibabaPrimarySourceKey;
    let rawDetail: unknown;
    let sourceRevision: string | null = null;
    let variantSources: { id: string; sources: string[]; unboundSources: string[] }[] = [];
    let gallerySources: string[] = [];
    let descriptionSources: string[] = [];
    if (typeof sourceKey === 'string' && sourceKey !== '') {
      const plan = await readAlibabaDetailPreviewPlan(productId, projectedProduct, page - 1);
      if (!plan.ok) return plan;
      sourceRevision = plan.packet.revision;
      rawDetail = {
        ...plan.detail,
        ...(plan.packet.content
          ? { schemaVersion: 'catalog-product-detail-v2', content: plan.packet.content }
          : {}),
        ...(plan.packet.noteBlocks
          ? { schemaVersion: 'catalog-product-detail-v3', noteBlocks: plan.packet.noteBlocks }
          : {}),
      };
      variantSources = plan.packet.variantMedia;
      gallerySources = plan.sourceMedia.gallerySources;
      descriptionSources = plan.sourceMedia.descriptionSources;
      const [source, observation, link] = await Promise.all([
        get('alibabaSourceProducts', sourceKey),
        get('catalogSourceObservations', sourceObservationDocumentId('alibaba', sourceKey)),
        get('alibabaProductLinks', sourceKey),
      ]);
      const binding =
        source && observation?.active !== false ? sourceBindingSnapshot(source, observation) : null;
      const primary = source ? primarySourceLinkSnapshot(source, link, productId) : null;
      if (
        !binding?.ok ||
        !primary?.ok ||
        binding.expectation.sourceHash !== plan.packet.expectedBinding.sourceHash ||
        binding.expectation.observationHash !== plan.packet.expectedBinding.observationHash ||
        primary.linkHash !== plan.packet.expectedBinding.linkHash
      )
        return { ok: false as const, code: 'CONFLICT' as const };
    } else {
      // Preserve the existing refusal until manual configurations have their lossless projection.
      for (let queryPage = 1; queryPage <= 100; queryPage++) {
        const rows = await list({
          collection: 'productVariants',
          page: queryPage,
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
        if (
          rows.items.some(
            (row) =>
              !(
                typeof row.detailSourceOwner === 'string' &&
                row.detailSourceOwner.startsWith('alibaba:')
              ),
          )
        )
          return { ok: false as const, code: 'MANUAL_CONFIGURATIONS' as const };
        if (!rows.items.length || queryPage * 100 >= rows.total) break;
      }
      const name = typeof product.name === 'string' ? product.name : '';
      rawDetail = {
        ...applyWebsiteDetailHeader(manualDetailCandidate({ _id: productId, name }), {
          ...projectedProduct,
          detailSourceOwner: `manual:${productId}`,
        }),
        variants: { items: [], total: 0, page, pageSize: 50, hasMore: false },
      };
    }
    const detail = decodeCatalogDetailView(rawDetail);
    if (!detail.ok) return catalogValidationFailure('review', detail.issues);
    if (page > Math.max(1, Math.ceil(detail.value.variants.total / detail.value.variants.pageSize)))
      return catalogValidationFailure('review', [
        CatalogIssueSchema.parse({
          code: 'INVALID_VALUE',
          path: 'page',
          stage: 'commit',
          severity: 'error',
          remedy: 'reload',
        }),
      ]);
    const [current, actor] = await Promise.all([get('products', productId), get('users', actorId)]);
    if (!admin(actor)) return { ok: false as const, code: 'FORBIDDEN' as const };
    if (!current || productDigest(current) !== initialProductDigest)
      return { ok: false as const, code: 'CONFLICT' as const };
    const inputDigest = sourceDigest([
      'catalog-preview-v1',
      initialProductDigest,
      sourceRevision,
      ...(detail.value.variants.pageSize === 50
        ? []
        : ['catalog-detail-pagination-v1', detail.value.variants.pageSize]),
    ]);
    if (parsed.data.inputDigest !== undefined && parsed.data.inputDigest !== inputDigest)
      return { ok: false as const, code: 'CONFLICT' as const };
    return {
      ok: true as const,
      kind: 'preview' as const,
      productId,
      inputDigest,
      detail: detail.value,
      previewMedia: {
        galleryIds: ids(detail.value.images),
        descriptionIds: ids(detail.value.descriptionImages ?? []),
        gallerySources,
        descriptionSources,
        variantSources,
      },
    };
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return catalogValidationFailure('review', error.issues);
    throw error;
  }
}
