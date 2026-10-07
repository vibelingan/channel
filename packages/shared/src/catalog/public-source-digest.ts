/**
 * A stable fingerprint of what a buyer would see from a supplier source (DEC-6):
 * each SKU's options, photos and prices, the product-level price, the photos,
 * the specification facts and the description text. Not stock, timestamps,
 * capture details, evidence ids or the supplier's title (the name is
 * admin-owned). Two observations of an unchanged listing hash the same, so a
 * sync can tell "changed since approval" from "seen again" (MIU-16).
 *
 * Fields are picked explicitly, never whole objects, so a stored observation
 * and its re-validated copy hash the same even if one carries extra keys.
 * Server-only (node:crypto): never re-export from a module the site imports.
 */
import { createHash } from 'node:crypto';
import type { CatalogOfferPricing } from './offer-pricing.ts';

interface DigestFact {
  sourceName: string;
  value: string | number | boolean;
}
interface DigestMedia {
  sourceUrl: string;
}

/**
 * Structural: the catalog-import source observation satisfies it (checked by
 * the parity test there). Optional members accept an explicit `undefined`, as
 * zod's inferred types carry it.
 */
export interface PublicSourceDigestInput {
  identity: { attributes: readonly DigestFact[] };
  content: {
    description?: { text?: string | undefined } | undefined;
    media: readonly DigestMedia[];
  };
  variants: readonly {
    sourceVariantKey: string;
    options: readonly DigestFact[];
    media?: readonly DigestMedia[] | undefined;
  }[];
  offers: readonly {
    sourceVariantKey?: string | undefined;
    kind: string;
    pricing: CatalogOfferPricing;
  }[];
}

const DIGEST_VERSION = 'public-source-digest-v1';

function pricing(value: CatalogOfferPricing): unknown[] {
  const moq = value.minimumOrderQuantity ?? null;
  switch (value.mode) {
    case 'fixed':
      return ['fixed', value.currency, value.amountMinor, moq];
    case 'range':
      return ['range', value.currency, value.minimumAmountMinor, value.maximumAmountMinor, moq];
    case 'tiered':
      return [
        'tiered',
        value.currency,
        moq,
        value.tiers.map((tier) => [
          tier.minimumQuantity,
          tier.maximumQuantity ?? null,
          tier.unitAmountMinor,
        ]),
      ];
    case 'negotiable':
      return ['negotiable', value.currency ?? null, moq];
    case 'unavailable':
      return ['unavailable', moq];
  }
}

// Trimmed like the candidate builder, so a whitespace-only edit is not a change.
const facts = (values: readonly DigestFact[]) =>
  values.map((fact) => [
    fact.sourceName.trim(),
    typeof fact.value === 'string' ? fact.value.trim() : fact.value,
  ]);
const urls = (values: readonly DigestMedia[] | undefined) =>
  (values ?? []).map((media) => media.sourceUrl);

/** Offers in a canonical order: their keys are provider-assigned, not content. */
function offerSet(offers: PublicSourceDigestInput['offers']): string[] {
  return offers.map((offer) => JSON.stringify([offer.kind, pricing(offer.pricing)])).sort();
}

export function publicSourceDigest(observation: PublicSourceDigestInput): string {
  const skus = [...observation.variants]
    .sort((left, right) => (left.sourceVariantKey < right.sourceVariantKey ? -1 : 1))
    .map((variant) => [
      variant.sourceVariantKey,
      facts(variant.options),
      urls(variant.media),
      offerSet(
        observation.offers.filter((offer) => offer.sourceVariantKey === variant.sourceVariantKey),
      ),
    ]);
  const canonical = [
    DIGEST_VERSION,
    skus,
    offerSet(observation.offers.filter((offer) => offer.sourceVariantKey === undefined)),
    urls(observation.content.media),
    facts(observation.identity.attributes),
    observation.content.description?.text?.trim() ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
