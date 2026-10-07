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

export const CatalogPriceSummarySchema = z
  .object({
    source: z.enum(['website', 'sku', 'product']),
    /** The SKU that supplied the price, when `source` is `sku`. */
    variantId: z.string().min(1).max(200).optional(),
    pricing: catalogOfferPricingSchema,
  })
  .strict();
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

function lowestAmount(pricing: CatalogOfferPricing): number | undefined {
  switch (pricing.mode) {
    case 'fixed':
      return pricing.amountMinor;
    case 'range':
      return pricing.minimumAmountMinor;
    case 'tiered':
      return Math.min(...pricing.tiers.map((tier) => tier.unitAmountMinor));
    default:
      return undefined;
  }
}

// Same preference as the sync's card price (alibaba-merge-policy.ts): USD, then
// CNY, then any other currency alphabetically; then the lowest amount.
const currencyRank = (currency: string) =>
  currency === 'USD' ? '0' : currency === 'CNY' ? '1' : `2${currency}`;

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

/**
 * Website price if set (it is authoritative, including "request a quote");
 * otherwise the cheapest priced SKU; otherwise the product-level price;
 * otherwise no summary (the card shows "Request a quote"). Never throws.
 */
export function derivePriceSummary(input: PriceSummaryInput): CatalogPriceSummary | undefined {
  const website = input.websitePricing?.pricing;
  if (website) {
    const moqOnly =
      (website.mode === 'unavailable' || website.mode === 'negotiable') &&
      website.minimumOrderQuantity !== undefined;
    return lowestAmount(website) !== undefined || moqOnly
      ? { source: 'website', pricing: website }
      : undefined;
  }
  const sku = cheapest(input.variants);
  if (sku?.variantId !== undefined) {
    return { source: 'sku', variantId: sku.variantId, pricing: sku.pricing };
  }
  const product = cheapest([{ offers: input.offers }]);
  return product ? { source: 'product', pricing: product.pricing } : undefined;
}
