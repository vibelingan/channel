import type { CatalogPricingInput } from '@vibelingan-channel/shared/catalog';
import {
  AlibabaCatalogPricingBlock,
  DEFAULT_ALIBABA_PRICING_LABELS,
  alibabaPriceSummary,
} from './AlibabaCatalogPricingBlock.tsx';
import { QuantityTierPricingBlock, quantityTierPriceSummary } from './QuantityTierPricingBlock.tsx';
import { formatPrice } from './api.ts';
import { effectiveCatalogPricing } from './catalog-pricing.ts';

export function effectiveCatalogPriceSummary(
  product: CatalogPricingInput,
  quoteLabel: string,
): string {
  const decision = effectiveCatalogPricing(product);
  if (decision.source === 'manual-tiered') return quantityTierPriceSummary(decision.pricing);
  if (decision.source === 'scalar') return formatPrice(decision.amount);
  if (decision.source === 'alibaba') {
    return alibabaPriceSummary(decision.pricing) ?? DEFAULT_ALIBABA_PRICING_LABELS.unavailableLabel;
  }
  return quoteLabel;
}

export function EffectiveCatalogPricingBlock({
  product,
  quoteLabel = 'Request a quote',
}: { product: CatalogPricingInput; quoteLabel?: string }) {
  const decision = effectiveCatalogPricing(product);
  return (
    <div data-effective-pricing={decision.source}>
      {decision.source === 'alibaba' ? (
        <AlibabaCatalogPricingBlock pricing={decision.pricing} size="lg" />
      ) : decision.source === 'manual-tiered' ? (
        <QuantityTierPricingBlock pricing={decision.pricing} />
      ) : (
        <p className="font-display text-2xl font-bold text-brand-700">
          {decision.source === 'scalar' ? formatPrice(decision.amount) : quoteLabel}
        </p>
      )}
    </div>
  );
}
