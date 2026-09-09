import {
  type ManualCatalogPricing,
  validateManualCatalogPricing,
} from '../manual-catalog-pricing.ts';
import type { AlibabaPricingAdapter, AlibabaPricingDecision } from './alibaba-pricing-adapter.ts';

export interface CatalogPricingInput {
  catalogPricingMode?: unknown;
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
  product: CatalogPricingInput,
  alibabaAdapter: AlibabaPricingAdapter,
): CatalogPricingDecision {
  const mode = product.catalogPricingMode;
  if (mode !== undefined && mode !== 'source' && mode !== 'manual') {
    return { source: 'quote-required' };
  }
  if (mode !== 'source') {
    const manual = validateManualCatalogPricing(product.manualCatalogPricing);
    if (manual.ok) return { source: 'manual-tiered', pricing: manual.value };

    for (const field of ['wholesalePrice', 'unitPrice'] as const) {
      const amount = product[field];
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
        return { source: 'scalar', field, amount, currency: 'USD' };
      }
    }
    // An explicit override must not silently turn into a different source price.
    if (mode === 'manual') return { source: 'quote-required' };
  }
  if (Object.hasOwn(product, 'alibabaPrimarySourceKey')) {
    return {
      source: 'alibaba',
      pricing: alibabaAdapter.resolve(
        product.alibabaPrimarySourceKey,
        product.alibabaCatalogPricing,
      ),
    };
  }

  return { source: 'quote-required' };
}
