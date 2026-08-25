import type { ManualCatalogPricing } from '../manual-catalog-pricing.ts';
import type { AlibabaPricingAdapter, AlibabaPricingDecision } from './alibaba-pricing-adapter.ts';

export interface CatalogPricingInput {
  alibabaPrimarySourceKey?: unknown;
  alibabaCatalogPricing?: unknown;
  manualCatalogPricing?: unknown;
  wholesalePrice?: unknown;
  unitPrice?: unknown;
}

export type CatalogPricingDecision =
  | { source: 'alibaba'; pricing: AlibabaPricingDecision }
  | { source: 'manual-tiered'; pricing: ManualCatalogPricing }
  | {
      source: 'scalar';
      field: 'wholesalePrice' | 'unitPrice';
      amount: number;
      currency: 'USD';
    }
  | { source: 'quote-required' };

export function resolveCatalogPricing(
  _product: CatalogPricingInput,
  _alibabaAdapter: AlibabaPricingAdapter,
): CatalogPricingDecision {
  throw new Error('MIU 07 catalog pricing resolver not implemented');
}
