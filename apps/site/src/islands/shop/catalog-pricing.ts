import type { AlibabaCatalogPricing, Product, ProductFamily } from './catalog-types.ts';

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

export function validAlibabaTiers(pricing: AlibabaCatalogPricing): boolean {
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
