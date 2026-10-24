import {
  type CatalogPricingInput,
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import {
  type CatalogPriceSummary,
  CatalogPriceSummarySchema,
  priceSummaryMoq,
} from '@vibelingan-channel/shared/catalog-detail';
import type { AlibabaCatalogPricing, Product, ProductFamily } from './catalog-types.ts';

/** The approved price summary, or undefined when absent or malformed (never throws). */
export function readPriceSummary(product: {
  priceSummary?: unknown;
}): CatalogPriceSummary | undefined {
  const parsed = CatalogPriceSummarySchema.safeParse(product.priceSummary);
  return parsed.success ? parsed.data : undefined;
}

const alibabaAdapter = createAlibabaPricingAdapter();

/** The one pricing policy used by cards, detail, admin preview and structured data. */
export function effectiveCatalogPricing(product: CatalogPricingInput) {
  return resolveCatalogPricing(product, alibabaAdapter);
}

/**
 * Card/detail MOQ. An approved product's summary is the only input (MIU-12), so a
 * stale row `moq` or Alibaba quote from an old cached payload never shows.
 */
export function effectiveCatalogMoq(
  product: CatalogPricingInput & { moq?: unknown; priceSummary?: unknown },
): number | undefined {
  const summary = readPriceSummary(product);
  if (summary) return priceSummaryMoq(summary);
  const decision = effectiveCatalogPricing(product);
  if (decision.source === 'alibaba') return decision.pricing.sourceMoq;
  if (decision.source === 'manual-tiered') return decision.pricing.tiers[0]?.minQuantity;
  return validPositiveInteger(product.moq) ? product.moq : undefined;
}

type PublicationCompleteCatalogProduct = Product & {
  productFamily: ProductFamily;
  slug: string;
  skuCode: string;
  description: string;
  images: string[];
};

export function validMinorAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validAlibabaTiers(
  pricing: Pick<AlibabaCatalogPricing, 'tiers' | 'sourceMoq'>,
): boolean {
  const tiers = pricing.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) return false;
  for (const [index, tier] of tiers.entries()) {
    if (
      !validPositiveInteger(tier.minQuantity) ||
      !validMinorAmount(tier.unitAmountMinor) ||
      (tier.maxQuantity !== undefined &&
        (!validPositiveInteger(tier.maxQuantity) || tier.maxQuantity < tier.minQuantity)) ||
      (tier.maxQuantity === undefined && index !== tiers.length - 1)
    ) {
      return false;
    }
    const next = tiers[index + 1];
    if (
      next &&
      (!validPositiveInteger(next.minQuantity) ||
        next.minQuantity <= tier.minQuantity ||
        (tier.maxQuantity !== undefined && next.minQuantity <= tier.maxQuantity))
    ) {
      return false;
    }
  }
  return (
    pricing.sourceMoq === undefined ||
    (validPositiveInteger(pricing.sourceMoq) && tiers[0].minQuantity <= pricing.sourceMoq)
  );
}

export function publicManualPrice(product: Product): number | undefined {
  for (const amount of [product.wholesalePrice, product.unitPrice]) {
    if (amount !== undefined && Number.isFinite(amount) && amount >= 0) return amount;
  }
  return undefined;
}

export function isPublicationCompleteCatalogProduct(
  product: Product,
): product is PublicationCompleteCatalogProduct {
  return Boolean(
    product.name.trim() &&
      product.productFamily &&
      product.slug?.trim() &&
      product.skuCode?.trim() &&
      product.description?.trim() &&
      product.images?.some(Boolean),
  );
}
