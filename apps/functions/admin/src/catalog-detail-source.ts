import { createHash } from 'node:crypto';
import { buildCatalogDetailCandidate } from '@vibelingan-channel/catalog-import/detail-candidate';
import {
  type CatalogSourceObservation,
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { buildStructuredContent } from '@vibelingan-channel/catalog-import/structured-content';
import { get, list, persistCatalogDetailApproval } from '@vibelingan-channel/db';
import { sourceDigest, sourceGalleryDigest } from '@vibelingan-channel/db/catalog-source-staging';
import { isProductFamily } from '@vibelingan-channel/shared';
import { z } from 'zod';

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
  const parsed = command.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const { productId, page } = parsed.data;
  const product = await get('products', productId);
  if (!product) return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
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
  const observationId = sourceObservationDocumentId('alibaba', sourceKey);
  const row = await get('catalogSourceObservations', observationId);
  const valid = validateCatalogSourceObservation(row?.observation);
  if (
    !valid.ok ||
    valid.value.source.completeness !== 'full-product' ||
    valid.value.source.provider !== 'alibaba' ||
    valid.value.source.sourceProductKey !== sourceKey
  )
    return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  const observation = valid.value;
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
  const candidate = buildCatalogDetailCandidate(
    observation,
    { productId, variants, images, ...catalogCategoryLabel(product.productFamily) },
    page + 1,
    20,
  );
  if (!candidate.ok) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const { variants: pageVariants, revision: _revision, ...header } = candidate.value;
  const structured = buildStructuredContent(observation.content.description);
  const observationDigest = sourceDigest(row?.observation);
  const galleryDigest = sourceGalleryDigest(product);
  const revision = sourceDigest([
    observationDigest,
    galleryDigest,
    [...images].sort(),
    [...variants],
  ]);
  return persistCatalogDetailApproval(actorId, {
    action: 'source-page',
    productId,
    sourceKey,
    observationId,
    observationDigest,
    galleryDigest,
    revision,
    header,
    content: structured.content ?? null,
    noteBlocks: structured.noteBlocks ?? null,
    variantIds: [...variants.values()],
    page,
    variants: pageVariants.items,
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
    variantMedia: observation.variants.slice(page * 20, (page + 1) * 20).map((variant) => {
      const id = variants.get(variant.sourceVariantKey);
      if (!id) throw new Error('Canonical variant binding changed during source preparation');
      return {
        id,
        sources: variant.media.slice(0, 9).map((m) => m.sourceUrl),
        unboundSources: variant.media
          .slice(0, 9)
          .filter((m) => !images.has(m.sourceUrl))
          .map((m) => m.sourceUrl),
      };
    }),
  });
}
