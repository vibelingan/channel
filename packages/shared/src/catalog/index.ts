/**
 * Public catalog contract — the single network schema for the storefront
 * catalog surface (docs/catalog-architecture-hardening, MIU 2).
 *
 * Owns the strict `PublicProductSchema` / `CatalogPageSchema` envelope that
 * every server (public API projection) and browser (decoder) consumer parses
 * against. Unknown and role-gated/private keys are rejected. This module must
 * NOT import the database, HTTP, React, Astro, the shared root barrel, or
 * family-content types — it is the dependency-free contract every context
 * shares.
 */
import { z } from 'zod';
import { PRODUCT_FAMILY_OPTIONS } from '../catalog-product.ts';
import { manualCatalogPricingSchema } from '../manual-catalog-pricing.ts';
import { alibabaCatalogPricingSchema } from './alibaba-pricing-adapter.ts';

export {
  ALIBABA_CATALOG_PRICING_SCHEMA_VERSION,
  type AlibabaPricingAdapter,
  type AlibabaPricingDecision,
  alibabaCatalogPricingSchema,
  createAlibabaPricingAdapter,
} from './alibaba-pricing-adapter.ts';

const nonEmptyString = z.string().trim().min(1);
const nonNegativeInt = z.number().int().nonnegative().finite();
const nonNegativeNumber = z.number().nonnegative().finite();

/**
 * Strict public product contract. `_id`, `name`, and the canonical
 * `productFamily` are required before every server/browser consumer; every
 * other field is an optional public-projection key. Role-gated (`vipPrice`),
 * server-side (`imageIds`), and supplier offer keys are absent, so `.strict()`
 * rejects them.
 */
export const PublicProductSchema = z
  .object({
    _id: nonEmptyString,
    name: nonEmptyString,
    productFamily: z.enum(PRODUCT_FAMILY_OPTIONS),
    category: nonEmptyString.optional(),
    series: nonEmptyString.optional(),
    modName: nonEmptyString.optional(),
    modType: nonEmptyString.optional(),
    description: nonEmptyString.optional(),
    productCode: nonEmptyString.optional(),
    skuCode: nonEmptyString.optional(),
    slug: nonEmptyString.optional(),
    moq: nonNegativeInt.optional(),
    inventory: nonNegativeInt.optional(),
    unitPrice: nonNegativeNumber.optional(),
    wholesalePrice: nonNegativeNumber.optional(),
    clearancePrice: nonNegativeNumber.optional(),
    published: z.boolean().optional(),
    images: z.array(z.string()).optional(),
    manualCatalogPricing: manualCatalogPricingSchema.optional(),
    alibabaPrimarySourceKey: nonEmptyString.optional(),
    alibabaCatalogPricing: alibabaCatalogPricingSchema.optional(),
    alibabaSourceStatus: z
      .enum(['available', 'limited', 'unavailable', 'removed', 'unknown'])
      .optional(),
    alibabaSourceLastSyncedAt: z.string().optional(),
  })
  .strict();

export type PublicProduct = z.infer<typeof PublicProductSchema>;

/** Generic paginated catalog envelope. */
export interface CatalogPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Build a strict page schema over any item schema, preserving its strictness. */
export function catalogPageSchema<Item extends z.ZodTypeAny>(itemSchema: Item) {
  return z
    .object({
      items: z.array(itemSchema),
      total: z.number().int().nonnegative().finite(),
      page: z.number().int().positive().finite(),
      pageSize: z.number().int().positive().finite(),
    })
    .strict();
}

/** The public product page envelope (`items`, `total`, `page`, `pageSize`). */
export const CatalogPageSchema = catalogPageSchema(PublicProductSchema);
