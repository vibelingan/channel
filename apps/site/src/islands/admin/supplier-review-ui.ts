/**
 * Pure helpers for the admin's side-by-side review of supplier changes and
 * configuration photos (DEC-19, DEC-20).
 */
import type { CatalogOfferPricing } from '@vibelingan-channel/shared/catalog-pricing';
import {
  type ConfigurationPhotos,
  type SupplierDecisions,
  SupplierDecisionsSchema,
  type SupplierReview,
  type SupplierReviewPartName,
} from '@vibelingan-channel/shared/catalog-supplier-review';
import { formatCatalogQuoteAmount } from '../../catalog/presentation/CatalogQuoteConditions.tsx';

/** Choices made in this form, per part, for one exact incoming value. */
export type SupplierChoices = SupplierDecisions;

const amount = (minor: number, currency: string) => formatCatalogQuoteAmount(minor, currency);

/** A price as buyers read it. */
export function formatPricing(pricing: CatalogOfferPricing): string {
  switch (pricing.mode) {
    case 'fixed':
      return amount(pricing.amountMinor, pricing.currency);
    case 'range':
      return `${amount(pricing.minimumAmountMinor, pricing.currency)}–${(pricing.maximumAmountMinor / 100).toFixed(2)}`;
    case 'tiered':
      return pricing.tiers
        .map(
          (tier) =>
            `${tier.maximumQuantity === undefined ? `≥${tier.minimumQuantity}` : `${tier.minimumQuantity}–${tier.maximumQuantity}`}: ${amount(tier.unitAmountMinor, pricing.currency)}`,
        )
        .join(' · ');
    case 'negotiable':
      return 'Negotiable';
    case 'unavailable':
      return 'Request a quote';
  }
}

export const formatPricings = (pricings: readonly CatalogOfferPricing[]) =>
  pricings.length ? pricings.map(formatPricing).join('; ') : 'none';

/** Parts with no decision yet, from the server or this form. */
export function undecidedParts(
  review: SupplierReview,
  choices: SupplierChoices,
): SupplierReviewPartName[] {
  return review.parts
    .filter((part) => !part.decision && choices[part.part]?.incomingDigest !== part.incomingDigest)
    .map((part) => part.part);
}

/** Save's values plus the decisions (merged with earlier ones) and photo choices. */
export function withSupplierChoices(
  values: Record<string, unknown>,
  initial: Record<string, unknown> | undefined,
  choices: SupplierChoices,
  configurationPhotos: ConfigurationPhotos | undefined,
): Record<string, unknown> {
  const next = { ...values };
  if (Object.keys(choices).length > 0) {
    const earlier = SupplierDecisionsSchema.safeParse(initial?.supplierDecisions ?? {});
    next.supplierDecisions = { ...(earlier.success ? earlier.data : {}), ...choices };
  }
  if (configurationPhotos !== undefined) next.configurationPhotos = configurationPhotos;
  return next;
}
