/**
 * The single price a product card shows ("From $X"), derived from one approved
 * version at approval time. Same record, same approval as the product page; the
 * list reads only this instead of every SKU row. Pure and browser-safe.
 *
 * Imports only `offer-pricing.ts` (never `product-detail.ts`) so the publication
 * schema can embed it without an import cycle.
 */
import { z } from 'zod';
import { type CatalogOfferPricing, catalogOfferPricingSchema } from './offer-pricing.ts';

/** Amount-bearing, or a "request a quote" that still states a minimum order (DEC-16). */
function isMeaningful(pricing: CatalogOfferPricing): boolean {
  return lowestAmount(pricing) !== undefined || pricing.minimumOrderQuantity !== undefined;
}

export const CatalogPriceSummarySchema = z
  .object({
    source: z.enum(['website', 'sku', 'product']),
    /** The SKU that supplied the price; present exactly when `source` is `sku`. */
    variantId: z.string().min(1).max(200).optional(),
    pricing: catalogOfferPricingSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if ((summary.source === 'sku') !== (summary.variantId !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variantId'],
        message: 'variantId is required for SKU summaries and forbidden otherwise',
      });
    }
    if (!isMeaningful(summary.pricing)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricing'],
        message: 'a summary needs a price or a minimum order quantity',
      });
    }
  });
export type CatalogPriceSummary = z.infer<typeof CatalogPriceSummarySchema>;

interface PricedOffer {
  pricing: CatalogOfferPricing;
}

/** Structural input: the approved header's prices plus every approved SKU. */
export interface PriceSummaryInput {
  websitePricing?: PricedOffer | undefined;
  offers: readonly PricedOffer[];
  variants: readonly { id: string; offers: readonly PricedOffer[] }[];
}

/**
 * Lowest orderable unit amount. Tiers that end below the minimum order are
 * skipped, exactly as the product page skips them (`CatalogCompactPrice`).
 */
function lowestAmount(pricing: CatalogOfferPricing): number | undefined {
  switch (pricing.mode) {
    case 'fixed':
      return pricing.amountMinor;
    case 'range':
      return pricing.minimumAmountMinor;
    case 'tiered': {
      const moq = pricing.minimumOrderQuantity;
      const orderable = pricing.tiers.filter(
        (tier) =>
          moq === undefined || tier.maximumQuantity === undefined || tier.maximumQuantity >= moq,
      );
      return orderable.length
        ? Math.min(...orderable.map((tier) => tier.unitAmountMinor))
        : undefined;
    }
    default:
      return undefined;
  }
}

// Same preference as the sync's card price (alibaba-merge-policy.ts): USD, then
// CNY, then any other currency alphabetically; then the lowest amount.
const currencyRank = (currency: string) => {
  const code = currency.toUpperCase();
  return code === 'USD' ? '0' : code === 'CNY' ? '1' : `2${code}`;
};

interface Candidate {
  rank: string;
  amount: number;
  position: number;
  pricing: CatalogOfferPricing;
  variantId?: string;
}

function better(a: Candidate, b: Candidate | undefined): boolean {
  if (!b) return true;
  if (a.rank !== b.rank) return a.rank < b.rank;
  if (a.amount !== b.amount) return a.amount < b.amount;
  return a.position < b.position;
}

function cheapest(
  groups: readonly { id?: string; offers: readonly PricedOffer[] }[],
): Candidate | undefined {
  let best: Candidate | undefined;
  groups.forEach((group, position) => {
    for (const { pricing } of group.offers) {
      const amount = lowestAmount(pricing);
      if (amount === undefined || !('currency' in pricing) || pricing.currency === undefined) {
        continue;
      }
      const candidate: Candidate = {
        rank: currencyRank(pricing.currency),
        amount,
        position,
        pricing,
        ...(group.id === undefined ? {} : { variantId: group.id }),
      };
      if (better(candidate, best)) best = candidate;
    }
  });
  return best;
}

/** First "request a quote" that still states a minimum order. */
function firstMoqOnly(
  groups: readonly { id?: string; offers: readonly PricedOffer[] }[],
): { variantId?: string; pricing: CatalogOfferPricing } | undefined {
  for (const group of groups) {
    const offer = group.offers.find(({ pricing }) => isMeaningful(pricing));
    if (offer)
      return { ...(group.id === undefined ? {} : { variantId: group.id }), pricing: offer.pricing };
  }
  return undefined;
}

/**
 * 1. Website price if set (authoritative, including "request a quote").
 * 2. Otherwise the cheapest priced SKU; 3. otherwise the product-level price.
 * 4. Nothing priced: a minimum order, if one is stated (product-level first,
 *    then the first SKU), so the card can show the MOQ like the page does.
 * Otherwise no summary (the card shows "Request a quote"). Never throws.
 */
export function derivePriceSummary(input: PriceSummaryInput): CatalogPriceSummary | undefined {
  const website = input.websitePricing?.pricing;
  if (website) return isMeaningful(website) ? { source: 'website', pricing: website } : undefined;
  const sku = cheapest(input.variants);
  if (sku?.variantId !== undefined) {
    return { source: 'sku', variantId: sku.variantId, pricing: sku.pricing };
  }
  const product = cheapest([{ offers: input.offers }]);
  if (product) return { source: 'product', pricing: product.pricing };
  const productMoq = firstMoqOnly([{ offers: input.offers }]);
  if (productMoq) return { source: 'product', pricing: productMoq.pricing };
  const skuMoq = firstMoqOnly(input.variants);
  return skuMoq?.variantId !== undefined
    ? { source: 'sku', variantId: skuMoq.variantId, pricing: skuMoq.pricing }
    : undefined;
}
