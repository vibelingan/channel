/**
 * Provider-neutral source observations.
 *
 * `CatalogSourceAdapter` remains the file-ingest contract: detect bytes and
 * parse a complete import bundle. This is the lower, transport-independent
 * seam used after any collector has acquired its source data. A workbook, a
 * paged API sync and an operator-selected probe can all emit the same
 * observation without pretending they share an acquisition lifecycle.
 *
 * The runtime schema is deliberate. These values cross from provider parsers
 * into persistence and UI code, so TypeScript alone is not a trust boundary.
 * Objects are strict, price modes are discriminated, raw provider bodies are
 * forbidden, and source options use arrays instead of attacker-controlled
 * object keys.
 */
import { createHash } from 'node:crypto';
import { type ZodIssue, z } from 'zod';
import type { CatalogProvider } from './contracts.ts';

export const CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION = 'catalog-source-observation-v1' as const;

/** Provider-scoped materialized-view id; source keys never leak into DB ids. */
export function sourceObservationDocumentId(
  provider: CatalogProvider,
  sourceProductKey: string,
): string {
  return createHash('sha256').update(`${provider}\0${sourceProductKey}`).digest('hex');
}

const nonEmptyString = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && value.trim().length > 0, {
    message: 'must be a non-empty string without surrounding whitespace',
  });
const safeNonNegativeInteger = z.number().int().nonnegative().safe();
const safePositiveInteger = z.number().int().positive().safe();
const canonicalUtcInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine(
    (value) => {
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) return false;
      const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
      return new Date(parsed).toISOString() === canonical;
    },
    { message: 'must be a real UTC instant' },
  );
const currency = z
  .string()
  .min(1)
  .max(12)
  .refine((value) => value.trim() === value && value.trim().length > 0, {
    message: 'must be a non-empty currency without surrounding whitespace',
  });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const fixedPricingSchema = z
  .object({
    mode: z.literal('fixed'),
    currency,
    amountMinor: safeNonNegativeInteger,
    minimumOrderQuantity: safePositiveInteger.optional(),
  })
  .strict();

const rangePricingSchema = z
  .object({
    mode: z.literal('range'),
    currency,
    minimumAmountMinor: safeNonNegativeInteger,
    maximumAmountMinor: safeNonNegativeInteger,
    minimumOrderQuantity: safePositiveInteger.optional(),
  })
  .strict()
  .refine((value) => value.minimumAmountMinor <= value.maximumAmountMinor, {
    message: 'minimumAmountMinor must not exceed maximumAmountMinor',
  });

const priceTierSchema = z
  .object({
    minimumQuantity: safePositiveInteger,
    maximumQuantity: safePositiveInteger.optional(),
    unitAmountMinor: safeNonNegativeInteger,
  })
  .strict()
  .refine(
    (value) =>
      value.maximumQuantity === undefined || value.maximumQuantity >= value.minimumQuantity,
    { message: 'maximumQuantity must not be below minimumQuantity' },
  );

const tieredPricingSchema = z
  .object({
    mode: z.literal('tiered'),
    currency,
    minimumOrderQuantity: safePositiveInteger.optional(),
    tiers: z.array(priceTierSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 0; index < value.tiers.length; index += 1) {
      const tier = value.tiers[index];
      if (tier === undefined) continue;
      const next = value.tiers[index + 1];
      if (tier.maximumQuantity === undefined && next !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', index],
          message: 'only the final tier may be open-ended',
        });
      }
      if (next !== undefined && next.minimumQuantity <= tier.minimumQuantity) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', index + 1, 'minimumQuantity'],
          message: 'tiers must be strictly ordered by minimumQuantity',
        });
      }
      if (
        next !== undefined &&
        tier.maximumQuantity !== undefined &&
        next.minimumQuantity <= tier.maximumQuantity
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', index + 1, 'minimumQuantity'],
          message: 'tier windows overlap',
        });
      }
    }
  });

const negotiablePricingSchema = z
  .object({
    mode: z.literal('negotiable'),
    currency: currency.optional(),
    minimumOrderQuantity: safePositiveInteger.optional(),
  })
  .strict();

const unavailablePricingSchema = z
  .object({
    mode: z.literal('unavailable'),
    minimumOrderQuantity: safePositiveInteger.optional(),
  })
  .strict();

// Range/tier schemas carry cross-field refinements, which are ZodEffects in
// Zod 3 and therefore cannot participate in discriminatedUnion(). A regular
// union retains the same runtime strictness and the inferred tagged union.
export const catalogSourcePricingSchema = z.union([
  fixedPricingSchema,
  rangePricingSchema,
  tieredPricingSchema,
  negotiablePricingSchema,
  unavailablePricingSchema,
]);

const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  }, 'sourceUrl must use http or https');

const mediaSchema = z
  .object({
    sourceUrl: httpUrl,
    role: z.enum(['primary', 'gallery', 'variant']),
    position: safeNonNegativeInteger,
    variantSku: nonEmptyString.optional(),
  })
  .strict();

const sourceFactSchema = z
  .object({
    sourceName: nonEmptyString,
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
    canonicalKey: nonEmptyString.optional(),
  })
  .strict();

const inventorySchema = z
  .object({
    storeKey: nonEmptyString.optional(),
    quantity: safeNonNegativeInteger,
    semantics: z.enum(['onHand', 'sellable', 'unknown']),
    capturedAt: canonicalUtcInstant.optional(),
  })
  .strict();

const categorySchema = z
  .object({
    sourceTaxonomy: nonEmptyString,
    sourceCategoryId: nonEmptyString.optional(),
    sourceCategoryName: nonEmptyString.optional(),
  })
  .strict();

const matchHintsSchema = z
  .object({
    parentSku: nonEmptyString.optional(),
    sku: nonEmptyString.optional(),
    gtin: nonEmptyString.optional(),
    manufacturerPartNumber: nonEmptyString.optional(),
    brand: nonEmptyString.optional(),
  })
  .strict();

const descriptionSchema = z
  .object({
    sanitizedHtml: z.string().optional(),
    text: z.string().optional(),
    placeholder: z.boolean(),
    sanitized: z.boolean(),
    provenance: z.enum([
      'provider-description',
      'description',
      'short-description',
      'structured-fallback',
      'title-and-specs',
      'none',
    ]),
  })
  .strict();

const variantSchema = z
  .object({
    sourceVariantKey: nonEmptyString,
    externalVariantId: nonEmptyString.optional(),
    sku: nonEmptyString.optional(),
    matchHints: matchHintsSchema.optional(),
    options: z.array(sourceFactSchema),
    inventory: z.array(inventorySchema),
    media: z.array(mediaSchema),
  })
  .strict();

const offerSchema = z
  .object({
    sourceOfferKey: nonEmptyString,
    sourceVariantKey: nonEmptyString.optional(),
    externalVariantId: nonEmptyString.optional(),
    storeKey: nonEmptyString.optional(),
    kind: z.enum(['supplier', 'regular', 'promotion']),
    pricing: catalogSourcePricingSchema,
  })
  .strict();

const evidenceSchema = z
  .object({
    kind: z.enum(['raw-payload', 'source-file', 'source-record']),
    evidenceId: nonEmptyString,
    sha256: sha256.optional(),
    sourcePath: nonEmptyString.optional(),
  })
  .strict();

const warningSchema = z
  .object({
    code: nonEmptyString,
    message: nonEmptyString,
    sourcePath: nonEmptyString.optional(),
  })
  .strict();

export const catalogSourceObservationSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION),
    source: z
      .object({
        provider: z.enum(['dianxiaomi', 'alibaba', 'aliexpress', 'lazada', 'shopify']),
        sourceProductKey: nonEmptyString,
        externalProductId: nonEmptyString.optional(),
        accountKey: nonEmptyString.optional(),
        storeKey: nonEmptyString.optional(),
        observedAt: canonicalUtcInstant,
        sourceUpdatedAt: canonicalUtcInstant.optional(),
        captureMode: z.enum(['import', 'full', 'incremental', 'selected']),
        completeness: z.enum(['full-product', 'partial-product']),
      })
      .strict(),
    identity: z
      .object({
        title: nonEmptyString.optional(),
        brand: nonEmptyString.optional(),
        matchHints: matchHintsSchema,
        category: categorySchema.optional(),
        attributes: z.array(sourceFactSchema),
      })
      .strict(),
    content: z
      .object({
        description: descriptionSchema.optional(),
        media: z.array(mediaSchema),
      })
      .strict(),
    lifecycle: z
      .object({
        sourceListingStatus: z.enum(['published', 'draft', 'missing', 'unknown']),
      })
      .strict(),
    variants: z.array(variantSchema),
    offers: z.array(offerSchema),
    evidence: z.array(evidenceSchema).min(1),
    warnings: z.array(warningSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const variantKeys = new Set<string>();
    for (const [index, variant] of value.variants.entries()) {
      if (variantKeys.has(variant.sourceVariantKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['variants', index, 'sourceVariantKey'],
          message: 'duplicate sourceVariantKey',
        });
      }
      variantKeys.add(variant.sourceVariantKey);
    }

    const offerKeys = new Set<string>();
    for (const [index, offer] of value.offers.entries()) {
      if (offerKeys.has(offer.sourceOfferKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['offers', index, 'sourceOfferKey'],
          message: 'duplicate sourceOfferKey',
        });
      }
      offerKeys.add(offer.sourceOfferKey);
      if (offer.sourceVariantKey !== undefined && !variantKeys.has(offer.sourceVariantKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['offers', index, 'sourceVariantKey'],
          message: 'sourceVariantKey does not name an observation variant',
        });
      }
    }
  });

export type CatalogSourcePricing = z.infer<typeof catalogSourcePricingSchema>;
export type CatalogSourceObservation = z.infer<typeof catalogSourceObservationSchema>;
export type CatalogObservationWarning = CatalogSourceObservation['warnings'][number];

export interface CatalogObservationFinding {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  sourcePath?: string;
}

export interface CatalogObservationBatch {
  schemaVersion: typeof CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION;
  provider: CatalogProvider;
  observations: CatalogSourceObservation[];
  findings: CatalogObservationFinding[];
}

/** One deep adapter seam; acquisition, pagination and file detection stay upstream. */
export interface CatalogObservationAdapter<Input> {
  readonly provider: CatalogProvider;
  toObservations(input: Input): CatalogObservationBatch;
}

export type CatalogSourceObservationValidation =
  | { ok: true; value: CatalogSourceObservation }
  | { ok: false; errors: string[] };

export function validateCatalogSourceObservation(
  value: unknown,
): CatalogSourceObservationValidation {
  const parsed = catalogSourceObservationSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const formatIssues = (issues: readonly ZodIssue[]): string[] =>
    issues.flatMap((issue) => {
      if (issue.code === z.ZodIssueCode.invalid_union) {
        return issue.unionErrors.flatMap((error) => formatIssues(error.issues));
      }
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message.toLowerCase()}`;
    });
  return {
    ok: false,
    errors: [...new Set(formatIssues(parsed.error.issues))],
  };
}
