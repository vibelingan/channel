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
  _product: CatalogSeoProduct,
  _pricing: CatalogPricingDecision,
): CatalogSeoView {
  throw new Error('MIU 14 Catalog SEO view not implemented');
}
