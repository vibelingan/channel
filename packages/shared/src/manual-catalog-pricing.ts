import { z } from 'zod';

export const MANUAL_CATALOG_PRICING_SCHEMA_VERSION = 'manual-catalog-pricing-v1';
export const MANUAL_PRICE_CURRENCIES = ['USD', 'CNY'] as const;
export const MANUAL_PRICE_MAX_TIERS = 4;

export interface QuantityPriceTier {
  minQuantity: number;
  maxQuantity?: number | undefined;
  unitAmountMinor: number;
}

export interface ManualCatalogPricing {
  schemaVersion: typeof MANUAL_CATALOG_PRICING_SCHEMA_VERSION;
  currency: (typeof MANUAL_PRICE_CURRENCIES)[number];
  tiers: QuantityPriceTier[];
}

const positiveSafeInteger = z.number().int().positive().safe();
const minorAmount = z.number().int().nonnegative().safe();

const quantityPriceTierSchema = z
  .object({
    minQuantity: positiveSafeInteger,
    maxQuantity: positiveSafeInteger.optional(),
    unitAmountMinor: minorAmount,
  })
  .strict()
  .superRefine((tier, ctx) => {
    if (tier.maxQuantity !== undefined && tier.maxQuantity < tier.minQuantity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxQuantity'],
        message: 'Maximum quantity must be greater than or equal to minimum quantity',
      });
    }
  });

export const manualCatalogPricingSchema = z
  .object({
    schemaVersion: z.literal(MANUAL_CATALOG_PRICING_SCHEMA_VERSION),
    currency: z.enum(MANUAL_PRICE_CURRENCIES),
    tiers: z.array(quantityPriceTierSchema).min(1).max(MANUAL_PRICE_MAX_TIERS),
  })
  .strict()
  .superRefine((pricing, ctx) => {
    for (const [index, tier] of pricing.tiers.entries()) {
      if (tier.maxQuantity === undefined && index !== pricing.tiers.length - 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', index, 'maxQuantity'],
          message: 'Only the final quantity tier may be open-ended',
        });
      }
      const next = pricing.tiers[index + 1];
      if (!next) continue;
      if (next.minQuantity <= tier.minQuantity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', index + 1, 'minQuantity'],
          message: 'Quantity tiers must be strictly ascending with unique minimums',
        });
      } else if (tier.maxQuantity !== undefined && next.minQuantity <= tier.maxQuantity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', index + 1, 'minQuantity'],
          message: 'Quantity tiers must not overlap',
        });
      }
    }
  });

export type ManualPricingValidationResult =
  | { ok: true; value: ManualCatalogPricing }
  | { ok: false; errors: string[] };

export function validateManualCatalogPricing(value: unknown): ManualPricingValidationResult {
  const result = manualCatalogPricingSchema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        errors: result.error.issues.map((issue) =>
          issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
        ),
      };
}
