import { createHash } from 'node:crypto';
import { buildCatalogDetailCandidate } from '@vibelingan-channel/catalog-import/detail-candidate';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { buildStructuredContent } from '@vibelingan-channel/catalog-import/structured-content';
import { get, persistCatalogDetailApproval } from '@vibelingan-channel/db';
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
/** Read the existing observation; approval never invokes Alibaba or downloads media. */
export async function prepareCatalogSource(actorId: string, input: unknown) {
  const parsed = command.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const { productId, page } = parsed.data;
  const product = await get('products', productId);
  const sourceKey = product?.alibabaPrimarySourceKey;
  if (!product || typeof sourceKey !== 'string')
    return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
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
  // Only owned images that the operator attached to THIS gallery may reach the candidate.
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
        const transport = new URL(url);
        if (
          transport.protocol === 'http:' &&
          (transport.hostname === 'alicdn.com' || transport.hostname.endsWith('.alicdn.com'))
        )
          transport.protocol = 'https:';
        const link = await get('catalogSourceLinks', sourceMediaLinkId('alibaba', transport.href));
        if (
          link?.provider === 'alibaba' &&
          link.sourceUrl === transport.href &&
          typeof link.imageId === 'string' &&
          gallery.has(link.imageId)
        )
          images.set(url, link.imageId);
      }),
    );
  }
  const variants = new Map(
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
  const candidate = buildCatalogDetailCandidate(
    observation,
    {
      productId,
      variants,
      images,
      ...(isProductFamily(product.productFamily)
        ? {
            categoryLabel: {
              headphones: 'Headphones',
              'ai-gadgets': 'AI Gadgets',
              toys: 'Toys',
              misc: 'Misc',
            }[product.productFamily],
          }
        : {}),
    },
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
  });
}
