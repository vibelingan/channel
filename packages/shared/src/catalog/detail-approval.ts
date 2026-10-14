/** Pure write preflight. Reading, authorization, media readiness and atomic commit belong to callers. */
import { z } from 'zod';
import {
  CatalogIssueSchema,
  CatalogValidationError,
  catalogFailureIssue,
  parseCatalogData,
} from './issues.ts';
export const CATALOG_DETAIL_VARIANT_MAX_COUNT = 10000;
export const CATALOG_DETAIL_VARIANT_MAX_BYTES = 128 * 1024;
export const CATALOG_APPROVAL_JOB_MAX_BYTES = 512 * 1024;

const editContext = { stage: 'effective-content', remedy: 'edit' } as const;
import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '../media.ts';
import { manualFacts } from './manual-detail.ts';
import {
  CatalogContentSchema,
  CatalogDetailHeaderSchema,
  CatalogDetailPublicationSchema,
  type CatalogDetailVariant,
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
/** Private preparation input. Website-owned text is checked after applying the row. */
export const CatalogSourceDetailHeaderSchema = CatalogDetailHeaderSchema.extend({
  name: z.string(),
  descriptionText: z.string().optional(),
});

const websiteInput = z.object({
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
  detailSourceOwner: identity,
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

const productInput = websiteInput.extend({
  detailSourceReady: z.literal(true),
  detailSourceCandidate: CatalogSourceDetailHeaderSchema,
  detailSourceContentCandidate: z.unknown(),
  detailSourceNoteBlocksCandidate: z.unknown(),
});

const isManualOwner = (product: z.infer<typeof websiteInput>) =>
  product.detailSourceOwner.startsWith('manual:');
const positiveMoq = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function websitePricing(product: z.infer<typeof websiteInput>) {
  const decision = resolveManualCatalogPricing(product);
  // DEC-16: a manual product with no price but a minimum order shows
  // "Request a quote" with that minimum, on the card and the page.
  const moqOnly = positiveMoq(product.moq);
  if (
    isManualOwner(product) &&
    moqOnly !== undefined &&
    (decision.source === 'inherit' || decision.source === 'empty-manual')
  )
    return parseWebsitePricing({
      basis: 'website-manual',
      pricing: { mode: 'unavailable', minimumOrderQuantity: moqOnly },
    });
  if (decision.source === 'inherit') return undefined;
  if (decision.source === 'invalid')
    throw new CatalogValidationError([
      CatalogIssueSchema.parse({
        code: 'INVALID_VALUE',
        ...editContext,
        path: 'manualCatalogPricing',
        severity: 'error',
      }),
    ]);
  if (decision.source === 'manual-tiered')
    return parseWebsitePricing({
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
    return parseWebsitePricing({
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
    return parseWebsitePricing({
      basis: 'website-manual',
      pricing: { mode: 'unavailable' },
    });
  return undefined;
}
function parseWebsitePricing(input: unknown) {
  return parseCatalogData(WebsiteDetailPricingSchema, input, {
    ...editContext,
    prefix: ['pricing'],
  });
}

const variantInput = z.object({
  _id: identity,
  productId: identity,
  detailSourceOwner: identity,
  detailSourceMissing: z.literal(false),
  archived: z.literal(false).optional(),
  position: z.number().int().nonnegative().safe(),
  sku: z.string().optional(),
  // An entry array validates own keys without Zod's object-key stripping.
  optionValues: z.preprocess(
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null
        ? Object.entries(value)
        : undefined;
    },
    z.array(z.tuple([z.string(), z.string()])),
  ),
  imageIds,
  detailSourceCandidate: CatalogDetailVariantSchema,
});

/** Apply field ownership once, before validating the effective website header. */
export function applyWebsiteDetailHeader(
  source: z.infer<typeof CatalogSourceDetailHeaderSchema>,
  input: unknown,
) {
  const product = parseCatalogData(websiteInput, input, editContext);
  parseCatalogData(z.literal(source._id), product._id, { ...editContext, prefix: ['_id'] });
  const { descriptionText: _description, ...withoutDescription } = source;
  const description = product.description?.trim();
  return parseCatalogData(
    CatalogDetailHeaderSchema,
    {
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
    },
    editContext,
  );
}

/** Project private preparation paths into the same website fields reported before staging. */
export function planCatalogDetailApproval(input: {
  product: unknown;
  variants: unknown;
  revision: string;
}) {
  try {
    return buildCatalogDetailApproval(input);
  } catch (error) {
    if (!(error instanceof CatalogValidationError)) throw error;
    throw new CatalogValidationError(
      error.issues.map((issue) => {
        const parts = issue.path.split('.');
        const source = parts.indexOf('detailSourceCandidate');
        if (source < 0) return issue;
        parts.splice(source, 1);
        return { ...issue, path: parts.join('.') || 'data', remedy: 'resync' };
      }),
    );
  }
}

/** Input rows must be the complete active source-owned set, not one page. No writes occur here. */
function buildCatalogDetailApproval(input: {
  product: unknown;
  variants: unknown;
  revision: string;
}) {
  const product = parseCatalogData(productInput, input.product, editContext);
  const rows = parseCatalogData(z.array(variantInput), input.variants, {
    ...editContext,
    prefix: ['variants', 'items'],
  });
  const source = product.detailSourceCandidate;
  if (source._id !== product._id)
    throw new CatalogValidationError([catalogFailureIssue('CONFLICT')]);
  const seen = new Set<string>();
  for (const row of rows) {
    if (
      row.productId !== product._id ||
      row.detailSourceOwner !== product.detailSourceOwner ||
      row.detailSourceCandidate.id !== row._id ||
      seen.has(row._id)
    )
      throw new CatalogValidationError([catalogFailureIssue('CONFLICT')]);
    seen.add(row._id);
  }
  rows.sort((a, b) => a.position - b.position || a._id.localeCompare(b._id));
  const header = applyWebsiteDetailHeader(source, product);
  const variants = rows.map((row, index) => {
    const canonicalOptions = row.optionValues.map(([name, value]) => ({ name, value }));
    const sourceOptions = row.detailSourceCandidate.options;
    const sourceMirror = new Map(sourceOptions.map(({ name, value }) => [name, value]));
    // Staging's legacy object keeps the last value per name. Recover the complete
    // source sequence when that mirror matches; keep differing canonical overrides.
    const unchangedSourceOptions =
      row.detailSourceOwner.startsWith('alibaba:') &&
      sourceMirror.size === canonicalOptions.length &&
      canonicalOptions.every(({ name, value }) => sourceMirror.get(name) === value);
    return parseCatalogData(
      CatalogDetailVariantSchema,
      {
        ...row.detailSourceCandidate,
        sku: row.sku || undefined,
        options: unchangedSourceOptions ? sourceOptions : canonicalOptions,
        images: row.imageIds.map((id) => `/api/images/${id}`),
      },
      { ...editContext, prefix: ['variants', 'items', index] },
    );
  });
  // SKU photos are independently bound and checked by the persistence gate.
  // Requiring them in the nine-image product gallery loses real provider mappings.
  const variantImageIds = [...new Set(rows.flatMap((row) => row.imageIds))];
  const unchanged = header.descriptionText === source.descriptionText;
  const content =
    unchanged && product.detailSourceContentCandidate != null
      ? parseCatalogData(CatalogContentSchema, product.detailSourceContentCandidate, {
          ...editContext,
          remedy: 'resync',
          prefix: ['content'],
        })
      : undefined;
  const noteBlocks =
    unchanged && product.detailSourceNoteBlocksCandidate != null
      ? parseCatalogData(CatalogNoteBlocksSchema, product.detailSourceNoteBlocksCandidate, {
          ...editContext,
          remedy: 'resync',
          prefix: ['noteBlocks'],
        })
      : undefined;
  // The card's "From $X" comes from this same version, computed while every SKU
  // is in memory, so the list never needs to read SKU rows.
  const priceSummary = derivePriceSummary({
    websitePricing: header.websitePricing,
    offers: header.offers,
    variants: variants.map((variant) => ({ id: variant.id, offers: variant.offers })),
  });
  const publication = parseCatalogData(
    CatalogDetailPublicationSchema,
    {
      state: 'approved',
      revision: input.revision,
      header,
      ...(content ? { content } : {}),
      ...(noteBlocks ? { noteBlocks } : {}),
      variantCount: variants.length,
      ...(variantImageIds.length ? { variantImageIds } : {}),
      ...(priceSummary ? { priceSummary } : {}),
    },
    { stage: 'commit', remedy: 'system-repair' },
  );
  return {
    publication,
    variants,
    imageIds: [
      ...new Set([...product.imageIds, ...(product.descriptionImageIds ?? []), ...variantImageIds]),
    ],
  };
}

/** Exact UTF-8 wire budget; source values stay complete and private when rejected. */
export function catalogVariantCapacityIssues(variants: readonly CatalogDetailVariant[]) {
  if (variants.length > CATALOG_DETAIL_VARIANT_MAX_COUNT)
    return [
      CatalogIssueSchema.parse({
        code: 'TOO_MANY',
        stage: 'effective-content',
        path: 'variants.items',
        severity: 'error',
        remedy: 'system-repair',
        expected: { maxCount: CATALOG_DETAIL_VARIANT_MAX_COUNT },
        observed: { count: variants.length },
      }),
    ];
  const encoder = new TextEncoder();
  return variants.flatMap((variant, index) => {
    const bytes = encoder.encode(JSON.stringify(variant)).byteLength;
    return bytes > CATALOG_DETAIL_VARIANT_MAX_BYTES
      ? [
          CatalogIssueSchema.parse({
            code: 'TOO_LARGE',
            stage: 'effective-content',
            path: `variants.items.${index}`,
            severity: 'error',
            remedy: 'system-repair',
            expected: { maxBytes: CATALOG_DETAIL_VARIANT_MAX_BYTES },
            observed: { bytes },
          }),
        ]
      : [];
  });
}
