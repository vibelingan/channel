/** Revision-bound paging within the existing browser and function response budgets. */
import { z } from 'zod';
import type { CatalogDetailPublicationSchema, CatalogDetailVariant } from './product-detail.ts';

export const CATALOG_DETAIL_PAGE_MAX_BYTES = 7 * 256 * 1024;
export const CATALOG_DETAIL_PAGINATION_POLICY = 'catalog-detail-pagination-v1';
export const CatalogDetailPaginationSchema = z
  .object({
    policyVersion: z.literal(CATALOG_DETAIL_PAGINATION_POLICY),
    revision: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value),
    pageSize: z.number().int().min(1).max(50),
  })
  .strict();

export function readCatalogDetailPageSize(
  product: Record<string, unknown>,
  revision: string,
): number | null {
  if (product.catalogDetailPagination == null) return 50;
  const value = CatalogDetailPaginationSchema.safeParse(product.catalogDetailPagination);
  return value.success && value.data.revision === revision ? value.data.pageSize : null;
}

export interface CatalogDetailPageMedia {
  galleryIds: readonly string[];
  descriptionIds: readonly string[];
  gallerySources: readonly string[];
  descriptionSources: readonly string[];
  variantSources: readonly {
    id: string;
    sources: readonly string[];
    unboundSources: readonly string[];
  }[];
}

type Publication = z.infer<typeof CatalogDetailPublicationSchema>;
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** One pass over every configuration; no repeated full-header serialization or retained JSON copies. */
export function planCatalogDetailPagination(
  publication: Pick<Publication, 'header' | 'content' | 'noteBlocks'>,
  variants: readonly CatalogDetailVariant[],
  media?: CatalogDetailPageMedia,
) {
  const { header, content, noteBlocks } = publication;
  // This is a sizing frame, not a DTO. It over-reserves the union of public,
  // review and preview envelope fields, including the largest legal revision.
  const baseBytes = encodedBytes({
    ok: true,
    data: {
      ok: true,
      kind: 'preview',
      productId: header._id,
      inputDigest: '0'.repeat(64),
      expectedDigest: '0'.repeat(64),
      expectedRevision: '\u0001'.repeat(200),
      detail: {
        ...header,
        revision: '\u0001'.repeat(200),
        ...(content ? { schemaVersion: 'catalog-product-detail-v2', content } : {}),
        ...(noteBlocks ? { schemaVersion: 'catalog-product-detail-v3', noteBlocks } : {}),
        variants: { items: [], total: 10000, page: 10000, pageSize: 50, hasMore: false },
      },
      previewMedia: {
        galleryIds: media?.galleryIds ?? [],
        descriptionIds: media?.descriptionIds ?? [],
        gallerySources: media?.gallerySources ?? [],
        descriptionSources: media?.descriptionSources ?? [],
        importDigest: '0'.repeat(64),
        allVariantsBound: false,
        variantSources: [],
      },
    },
  });
  let variantBytes = 0;
  for (const variant of variants) variantBytes = Math.max(variantBytes, encodedBytes(variant));
  let mediaBytes = 0;
  for (const source of media?.variantSources ?? [])
    mediaBytes = Math.max(mediaBytes, encodedBytes(source));
  const itemBytes = variantBytes + mediaBytes + 2;
  const pageSize = Math.max(
    1,
    Math.min(50, Math.floor((CATALOG_DETAIL_PAGE_MAX_BYTES - baseBytes) / itemBytes)),
  );
  return {
    pageSize,
    pageBytesBound: baseBytes + pageSize * itemBytes,
    singlePageFits: baseBytes + itemBytes <= CATALOG_DETAIL_PAGE_MAX_BYTES,
  };
}
