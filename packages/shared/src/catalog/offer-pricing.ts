/** Shared source-quote shape. Transport-neutral; safe to import in a browser. */
import { z } from 'zod';
const safeNonNegativeInteger = z.number().int().nonnegative().safe();
const safePositiveInteger = z.number().int().positive().safe();
const currency = z
  .string()
  .min(1)
  .max(12)
  .refine((value) => value.trim() === value && value.trim().length > 0, {
    message: 'must be a non-empty currency without surrounding whitespace',
  });

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
export const catalogOfferPricingSchema = z.union([
  fixedPricingSchema,
  rangePricingSchema,
  tieredPricingSchema,
  negotiablePricingSchema,
  unavailablePricingSchema,
]);
export type CatalogOfferPricing = z.infer<typeof catalogOfferPricingSchema>;
