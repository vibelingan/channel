import { catalogOfferPricingSchema } from '@vibelingan-channel/shared/catalog-pricing';
export type CatalogOfferView =
  | { status: 'unavailable' | 'quantity-required' | 'negotiable' | 'no-tier' }
  | { status: 'below-moq'; minimum: number }
  | { status: 'amount'; currency: string; amountMinor: number; tierIndex?: number }
  | { status: 'range'; currency: string; minimumAmountMinor: number; maximumAmountMinor: number };
/** A decision about exactly one source quote. No parent/SKU fallback or currency conversion. */
export function catalogOfferView(pricing: unknown, quantity: unknown): CatalogOfferView {
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1)
    return { status: 'quantity-required' };
  const parsed = catalogOfferPricingSchema.safeParse(pricing);
  if (!parsed.success) return { status: 'unavailable' };
  const price = parsed.data;
  if (price.minimumOrderQuantity !== undefined && quantity < price.minimumOrderQuantity)
    return { status: 'below-moq', minimum: price.minimumOrderQuantity };
  switch (price.mode) {
    case 'fixed':
      return { status: 'amount', currency: price.currency, amountMinor: price.amountMinor };
    case 'range':
      return {
        status: 'range',
        currency: price.currency,
        minimumAmountMinor: price.minimumAmountMinor,
        maximumAmountMinor: price.maximumAmountMinor,
      };
    case 'tiered': {
      const tierIndex = price.tiers.findIndex(
        (t) =>
          quantity >= t.minimumQuantity &&
          (t.maximumQuantity === undefined || quantity <= t.maximumQuantity),
      );
      const tier = price.tiers[tierIndex];
      return tier
        ? {
            status: 'amount',
            currency: price.currency,
            amountMinor: tier.unitAmountMinor,
            tierIndex,
          }
        : { status: 'no-tier' };
    }
    case 'negotiable':
      return { status: 'negotiable' };
    case 'unavailable':
      return { status: 'unavailable' };
    default: {
      const exhaustive: never = price;
      return exhaustive;
    }
  }
}
