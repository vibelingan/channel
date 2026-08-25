import { z } from 'zod';

export const ALIBABA_CATALOG_PRICING_SCHEMA_VERSION = 'alibaba-catalog-pricing-v1';

const minorAmount = z.number().int().nonnegative().safe();
const positiveSafeInt = z.number().int().positive().safe();
const canonicalUtc = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = parsed.toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
});
const alibabaPricingTierSchema = z
  .object({
    minQuantity: positiveSafeInt,
    maxQuantity: positiveSafeInt.optional(),
    unitAmountMinor: minorAmount,
  })
  .strict();

export const alibabaCatalogPricingSchema = z
  .object({
    schemaVersion: z.literal(ALIBABA_CATALOG_PRICING_SCHEMA_VERSION),
    source: z.literal('alibaba'),
    currency: z.enum(['CNY', 'USD']).optional(),
    mode: z.enum(['fixed', 'range', 'tiered', 'negotiable', 'unavailable']),
    amountMinor: minorAmount.optional(),
    minAmountMinor: minorAmount.optional(),
    maxAmountMinor: minorAmount.optional(),
    tiers: z.array(alibabaPricingTierSchema).optional(),
    sourceMoq: positiveSafeInt.optional(),
    sourceUpdatedAt: canonicalUtc.optional(),
    syncedAt: canonicalUtc,
  })
  .strict();

export type AlibabaPricingDecision =
  | {
      source: 'alibaba';
      state: 'available';
      mode: 'fixed';
      currency: 'CNY' | 'USD';
      amountMinor: number;
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'available';
      mode: 'range';
      currency: 'CNY' | 'USD';
      minAmountMinor: number;
      maxAmountMinor: number;
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'available';
      mode: 'tiered';
      currency: 'CNY' | 'USD';
      tiers: Array<{ minQuantity: number; maxQuantity?: number; unitAmountMinor: number }>;
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'quote';
      mode: 'negotiable';
      currency?: 'CNY' | 'USD';
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'unavailable';
      mode: 'unavailable';
      sourceMoq?: number;
    };

export interface AlibabaPricingAdapter {
  resolve(link: unknown, provider: unknown): AlibabaPricingDecision;
}

const unavailable = (sourceMoq?: number): AlibabaPricingDecision => ({
  source: 'alibaba',
  state: 'unavailable',
  mode: 'unavailable',
  ...(sourceMoq === undefined ? {} : { sourceMoq }),
});

function isMinorAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasNone(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => record[field] === undefined);
}

function validTiers(
  tiers: Array<{
    minQuantity: number;
    maxQuantity?: number | undefined;
    unitAmountMinor: number;
  }>,
  sourceMoq: number | undefined,
): boolean {
  if (tiers.length === 0) return false;
  for (const [index, tier] of tiers.entries()) {
    const next = tiers[index + 1];
    if (!Number.isSafeInteger(tier.minQuantity) || tier.minQuantity <= 0) return false;
    if (!isMinorAmount(tier.unitAmountMinor)) return false;
    if (
      tier.maxQuantity !== undefined &&
      (!Number.isSafeInteger(tier.maxQuantity) || tier.maxQuantity < tier.minQuantity)
    ) {
      return false;
    }
    if (tier.maxQuantity === undefined && next) return false;
    if (
      next &&
      (next.minQuantity <= tier.minQuantity ||
        (tier.maxQuantity !== undefined && next.minQuantity <= tier.maxQuantity))
    ) {
      return false;
    }
  }
  return (
    sourceMoq === undefined || (tiers[0]?.minQuantity ?? Number.POSITIVE_INFINITY) <= sourceMoq
  );
}

export function createAlibabaPricingAdapter(): AlibabaPricingAdapter {
  return {
    resolve(link: unknown, provider: unknown): AlibabaPricingDecision {
      if (typeof link !== 'string' || link.trim() === '') return unavailable();
      const parsed = alibabaCatalogPricingSchema.safeParse(provider);
      if (!parsed.success) return unavailable();
      const pricing = parsed.data;
      const record = pricing as Record<string, unknown>;

      switch (pricing.mode) {
        case 'fixed':
          return pricing.currency &&
            isMinorAmount(pricing.amountMinor) &&
            hasNone(record, ['minAmountMinor', 'maxAmountMinor', 'tiers'])
            ? {
                source: 'alibaba',
                state: 'available',
                mode: 'fixed',
                currency: pricing.currency,
                amountMinor: pricing.amountMinor,
                ...(pricing.sourceMoq === undefined ? {} : { sourceMoq: pricing.sourceMoq }),
              }
            : unavailable();
        case 'range':
          return pricing.currency &&
            isMinorAmount(pricing.minAmountMinor) &&
            isMinorAmount(pricing.maxAmountMinor) &&
            pricing.minAmountMinor <= pricing.maxAmountMinor &&
            hasNone(record, ['amountMinor', 'tiers'])
            ? {
                source: 'alibaba',
                state: 'available',
                mode: 'range',
                currency: pricing.currency,
                minAmountMinor: pricing.minAmountMinor,
                maxAmountMinor: pricing.maxAmountMinor,
                ...(pricing.sourceMoq === undefined ? {} : { sourceMoq: pricing.sourceMoq }),
              }
            : unavailable();
        case 'tiered':
          return pricing.currency &&
            pricing.tiers &&
            hasNone(record, ['amountMinor', 'minAmountMinor', 'maxAmountMinor']) &&
            validTiers(pricing.tiers, pricing.sourceMoq)
            ? {
                source: 'alibaba',
                state: 'available',
                mode: 'tiered',
                currency: pricing.currency,
                tiers: pricing.tiers.map((tier) => ({
                  minQuantity: tier.minQuantity,
                  ...(tier.maxQuantity === undefined ? {} : { maxQuantity: tier.maxQuantity }),
                  unitAmountMinor: tier.unitAmountMinor,
                })),
                ...(pricing.sourceMoq === undefined ? {} : { sourceMoq: pricing.sourceMoq }),
              }
            : unavailable();
        case 'negotiable':
          return hasNone(record, ['amountMinor', 'minAmountMinor', 'maxAmountMinor', 'tiers'])
            ? {
                source: 'alibaba',
                state: 'quote',
                mode: 'negotiable',
                ...(pricing.currency === undefined ? {} : { currency: pricing.currency }),
                ...(pricing.sourceMoq === undefined ? {} : { sourceMoq: pricing.sourceMoq }),
              }
            : unavailable();
        case 'unavailable':
          return hasNone(record, ['amountMinor', 'minAmountMinor', 'maxAmountMinor', 'tiers'])
            ? unavailable(pricing.sourceMoq)
            : unavailable();
      }
    },
  };
}
