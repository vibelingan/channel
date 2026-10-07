/** Pure write preflight. Reading, authorization, media readiness and atomic commit belong to callers. */
import { z } from 'zod';
import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '../media.ts';
import { manualFacts } from './manual-detail.ts';
import {
  CatalogContentSchema,
  CatalogDetailHeaderSchema,
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
  CatalogNoteBlocksSchema,
  WebsiteDetailPricingSchema,
  derivePriceSummary,
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
  // Spec fields a manual product's facts come from (MIU-27).
  skuCode: z.unknown(),
  series: z.unknown(),
  modName: z.unknown(),
  modType: z.unknown(),
});

const isManualOwner = (product: z.infer<typeof productInput>) =>
  product.detailSourceOwner.startsWith('manual:');
const positiveMoq = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function websitePricing(product: z.infer<typeof productInput>) {
  const decision = resolveManualCatalogPricing(product);
  // DEC-16: a manual product with no price but a minimum order shows
  // "Request a quote" with that minimum, on the card and the page.
  const moqOnly = positiveMoq(product.moq);
  if (
    isManualOwner(product) &&
    moqOnly !== undefined &&
    (decision.source === 'inherit' || decision.source === 'empty-manual')
  )
    return WebsiteDetailPricingSchema.parse({
      basis: 'website-manual',
      pricing: { mode: 'unavailable', minimumOrderQuantity: moqOnly },
    });
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
    // A manual product's facts are its spec fields; a synced one keeps its source facts.
    ...(isManualOwner(product) ? { facts: manualFacts(product) } : {}),
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
  // The card's "From $X" comes from this same version, computed while every SKU
  // is in memory, so the list never needs to read SKU rows.
  const priceSummary = derivePriceSummary({
    websitePricing: header.websitePricing,
    offers: header.offers,
    variants: variants.map((variant) => ({ id: variant.id, offers: variant.offers })),
  });
  const publication = CatalogDetailPublicationSchema.parse({
    state: 'approved',
    revision: input.revision,
    header,
    ...(content ? { content } : {}),
    ...(noteBlocks ? { noteBlocks } : {}),
    variantCount: variants.length,
    ...(variantImageIds.length ? { variantImageIds } : {}),
    ...(priceSummary ? { priceSummary } : {}),
  });
  return {
    publication,
    variants,
    imageIds: [
      ...new Set([...product.imageIds, ...(product.descriptionImageIds ?? []), ...variantImageIds]),
    ],
  };
}
