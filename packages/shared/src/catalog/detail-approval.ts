/** Pure write preflight. Reading, authorization, media readiness and atomic commit belong to callers. */
import { z } from 'zod';
import { validateManualCatalogPricing } from '../manual-catalog-pricing.ts';
import {
  CatalogContentSchema,
  CatalogDetailHeaderSchema,
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
  CatalogNoteBlocksSchema,
  WebsiteDetailPricingSchema,
} from './product-detail.ts';

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
  imageIds,
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
  if (product.catalogPricingMode === 'source') return undefined;
  if (product.catalogPricingMode !== undefined && product.catalogPricingMode !== 'manual')
    throw new Error('Unknown website pricing mode');
  const manual = validateManualCatalogPricing(product.manualCatalogPricing);
  if (manual.ok)
    return WebsiteDetailPricingSchema.parse({
      basis: 'website-manual',
      pricing: {
        mode: 'tiered',
        currency: manual.value.currency,
        minimumOrderQuantity: manual.value.tiers[0]?.minQuantity,
        tiers: manual.value.tiers.map((tier) => ({
          minimumQuantity: tier.minQuantity,
          maximumQuantity: tier.maxQuantity,
          unitAmountMinor: tier.unitAmountMinor,
        })),
      },
    });
  for (const amount of [product.wholesalePrice, product.unitPrice]) {
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
      const amountMinor = Math.round(amount * 100);
      if (!Number.isSafeInteger(amountMinor) || Math.abs(amount * 100 - amountMinor) > 0.000001)
        throw new Error('Website price has unsupported precision');
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
  }
  if (product.catalogPricingMode === 'manual')
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
  for (const variant of variants) {
    if (variant.images.some((url) => !header.images.includes(url)))
      throw new Error('Variant image must be in the approved product gallery');
  }
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
  });
  return { publication, variants, imageIds: product.imageIds };
}
