/** Pure write preflight. Reading, authorization, media readiness and atomic commit belong to callers. */
import { z } from 'zod';
import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '../media.ts';
import {
  CatalogContentSchema,
  CatalogDetailHeaderSchema,
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
  CatalogNoteBlocksSchema,
  WebsiteDetailPricingSchema,
} from './product-detail.ts';
import { resolveManualCatalogPricing, scalarPriceMinorUnits } from './resolve-pricing.ts';

const identity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());
const imageIds = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).max(9);
const productInput = z.object({
  _id: identity,
  name: z.string(),
  description: z.string().optional(),
  // Untouched sync drafts omit this field. Preview may have no owned gallery;
  // publication still enforces media readiness at the persistence boundary.
  imageIds: imageIds.default([]),
  descriptionImageIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]+$/))
    .max(PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT)
    .optional(),
  archived: z.literal(false).optional(),
  detailSourceReady: z.literal(true),
  detailSourceOwner: identity,
  detailSourceCandidate: CatalogDetailHeaderSchema,
  detailSourceContentCandidate: z.unknown(),
  detailSourceNoteBlocksCandidate: z.unknown(),
  catalogPricingMode: z.unknown(),
  manualCatalogPricing: z.unknown(),
  unitPrice: z.unknown(),
  wholesalePrice: z.unknown(),
  moq: z.unknown(),
  productFamily: z.enum(['headphones', 'ai-gadgets', 'toys', 'misc']).optional(),
});

function websitePricing(product: z.infer<typeof productInput>) {
  const decision = resolveManualCatalogPricing(product);
  if (decision.source === 'inherit') return undefined;
  if (decision.source === 'invalid') throw new Error(decision.reason);
  if (decision.source === 'manual-tiered')
    return WebsiteDetailPricingSchema.parse({
      basis: 'website-manual',
      pricing: {
        mode: 'tiered',
        currency: decision.pricing.currency,
        minimumOrderQuantity: decision.pricing.tiers[0]?.minQuantity,
        tiers: decision.pricing.tiers.map((tier) => ({
          minimumQuantity: tier.minQuantity,
          maximumQuantity: tier.maxQuantity,
          unitAmountMinor: tier.unitAmountMinor,
        })),
      },
    });
  if (decision.source === 'scalar') {
    const amountMinor = scalarPriceMinorUnits(decision.amount);
    return WebsiteDetailPricingSchema.parse({
      basis: 'website-manual',
      pricing: {
        mode: 'fixed',
        currency: 'USD',
        amountMinor,
        ...(typeof product.moq === 'number' && product.moq > 0
          ? { minimumOrderQuantity: product.moq }
          : {}),
      },
    });
  }
  if (decision.source === 'empty-manual')
    return WebsiteDetailPricingSchema.parse({
      basis: 'website-manual',
      pricing: { mode: 'unavailable' },
    });
  return undefined;
}
const variantInput = z.object({
  _id: identity,
  productId: identity,
  detailSourceOwner: identity,
  detailSourceMissing: z.literal(false),
  archived: z.literal(false).optional(),
  position: z.number().int().nonnegative().safe(),
  sku: z.string().optional(),
  optionValues: z.record(z.string()),
  imageIds,
  detailSourceCandidate: CatalogDetailVariantSchema,
});

/** Input rows must be the complete active source-owned set, not one page. No writes occur here. */
export function planCatalogDetailApproval(input: {
  product: unknown;
  variants: unknown;
  revision: string;
}) {
  const product = productInput.parse(input.product);
  const rows = z.array(variantInput).parse(input.variants);
  const source = product.detailSourceCandidate;
  if (source._id !== product._id) throw new Error('Product candidate identity mismatch');
  const seen = new Set<string>();
  for (const row of rows) {
    if (
      row.productId !== product._id ||
      row.detailSourceOwner !== product.detailSourceOwner ||
      row.detailSourceCandidate.id !== row._id ||
      seen.has(row._id)
    )
      throw new Error('Variant candidate identity or ownership mismatch');
    seen.add(row._id);
  }
  rows.sort((a, b) => a.position - b.position || a._id.localeCompare(b._id));
  const { descriptionText: _description, ...withoutDescription } = source;
  const description = product.description?.trim();
  const header = CatalogDetailHeaderSchema.parse({
    ...withoutDescription,
    name: product.name,
    ...(product.productFamily
      ? {
          categoryLabel: {
            headphones: 'Headphones',
            'ai-gadgets': 'AI Gadgets',
            toys: 'Toys',
            misc: 'Misc',
          }[product.productFamily],
        }
      : {}),
    images: product.imageIds.map((id) => `/api/images/${id}`),
    descriptionImages: product.descriptionImageIds?.map((id) => `/api/images/${id}`),
    websitePricing: websitePricing(product),
    ...(description ? { descriptionText: description } : {}),
  });
  const variants = rows.map((row) =>
    CatalogDetailVariantSchema.parse({
      ...row.detailSourceCandidate,
      sku: row.sku || undefined,
      options: Object.entries(row.optionValues).map(([name, value]) => ({ name, value })),
      images: row.imageIds.map((id) => `/api/images/${id}`),
    }),
  );
  // SKU photos are independently bound and checked by the persistence gate.
  // Requiring them in the nine-image product gallery loses real provider mappings.
  const variantImageIds = [...new Set(rows.flatMap((row) => row.imageIds))];
  const unchanged = header.descriptionText === source.descriptionText;
  const content =
    unchanged && product.detailSourceContentCandidate != null
      ? CatalogContentSchema.parse(product.detailSourceContentCandidate)
      : undefined;
  const noteBlocks =
    unchanged && product.detailSourceNoteBlocksCandidate != null
      ? CatalogNoteBlocksSchema.parse(product.detailSourceNoteBlocksCandidate)
      : undefined;
  const publication = CatalogDetailPublicationSchema.parse({
    state: 'approved',
    revision: input.revision,
    header,
    ...(content ? { content } : {}),
    ...(noteBlocks ? { noteBlocks } : {}),
    variantCount: variants.length,
    ...(variantImageIds.length ? { variantImageIds } : {}),
  });
  return {
    publication,
    variants,
    imageIds: [
      ...new Set([...product.imageIds, ...(product.descriptionImageIds ?? []), ...variantImageIds]),
    ],
  };
}
