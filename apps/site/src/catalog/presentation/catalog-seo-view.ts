import { isProductFamily } from '@vibelingan-channel/shared';
import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';

export interface CatalogSeoProduct {
  name: string;
  productFamily?: 'headphones' | 'ai-gadgets' | 'toys' | 'misc';
  slug?: string;
  skuCode?: string;
  description?: string;
  images?: readonly string[];
  moq?: number;
}

export type CatalogSeoOffer =
  | {
      type: 'Offer';
      priceCurrency: 'CNY' | 'USD';
      price: string;
      minimumOrderQuantity?: number;
    }
  | {
      type: 'AggregateOffer';
      priceCurrency: 'CNY' | 'USD';
      lowPrice: string;
      highPrice: string;
      minimumOrderQuantity?: number;
    };

export interface CatalogSeoView {
  name: string;
  canonicalPath?: string;
  description?: string;
  sku?: string;
  images: readonly string[];
  minimumOrderQuantity?: number;
  offer?: CatalogSeoOffer;
}

export function toCatalogSeoView(
  product: CatalogSeoProduct,
  pricing: CatalogPricingDecision,
): CatalogSeoView {
  const name = product.name.trim();
  const slug = product.slug?.trim();
  const description = product.description?.trim();
  const images = (product.images ?? []).map((image) => image.trim()).filter(Boolean);
  const addressable = Boolean(
    name && slug && description && images.length > 0 && isProductFamily(product.productFamily),
  );
  const minimumOrderQuantity =
    pricing.source === 'alibaba' ? pricing.pricing.sourceMoq : product.moq;
  const view: CatalogSeoView = {
    name,
    images,
    ...(addressable && slug
      ? { canonicalPath: `/products/item/?slug=${encodeURIComponent(slug)}` }
      : {}),
    ...(description ? { description } : {}),
    ...(product.skuCode?.trim() ? { sku: product.skuCode.trim() } : {}),
    ...(minimumOrderQuantity === undefined ? {} : { minimumOrderQuantity }),
  };
  if (!view.canonicalPath) return view;

  const withMoq = <Offer extends CatalogSeoOffer>(offer: Offer): Offer => ({
    ...offer,
    ...(minimumOrderQuantity === undefined ? {} : { minimumOrderQuantity }),
  });
  switch (pricing.source) {
    case 'manual-tiered': {
      const amounts = pricing.pricing.tiers.map((tier) => tier.unitAmountMinor);
      view.offer = withMoq({
        type: 'AggregateOffer',
        priceCurrency: pricing.pricing.currency,
        lowPrice: (Math.min(...amounts) / 100).toFixed(2),
        highPrice: (Math.max(...amounts) / 100).toFixed(2),
      });
      return view;
    }
    case 'scalar':
      view.offer = withMoq({
        type: 'Offer',
        priceCurrency: pricing.currency,
        price: pricing.amount.toFixed(2),
      });
      return view;
    case 'quote-required':
      return view;
    case 'alibaba':
      switch (pricing.pricing.mode) {
        case 'fixed':
          view.offer = withMoq({
            type: 'Offer',
            priceCurrency: pricing.pricing.currency,
            price: (pricing.pricing.amountMinor / 100).toFixed(2),
          });
          return view;
        case 'range':
          view.offer = withMoq({
            type: 'AggregateOffer',
            priceCurrency: pricing.pricing.currency,
            lowPrice: (pricing.pricing.minAmountMinor / 100).toFixed(2),
            highPrice: (pricing.pricing.maxAmountMinor / 100).toFixed(2),
          });
          return view;
        case 'tiered': {
          const amounts = pricing.pricing.tiers.map((tier) => tier.unitAmountMinor);
          view.offer = withMoq({
            type: 'AggregateOffer',
            priceCurrency: pricing.pricing.currency,
            lowPrice: (Math.min(...amounts) / 100).toFixed(2),
            highPrice: (Math.max(...amounts) / 100).toFixed(2),
          });
          return view;
        }
        case 'negotiable':
        case 'unavailable':
          return view;
        default: {
          const exhaustive: never = pricing.pricing;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = pricing;
      return exhaustive;
    }
  }
}
