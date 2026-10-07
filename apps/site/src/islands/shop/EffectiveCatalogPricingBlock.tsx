import type { CatalogPricingInput } from '@vibelingan-channel/shared/catalog';
import {
  type CatalogPriceSummary,
  lowestOrderableAmountMinor,
} from '@vibelingan-channel/shared/catalog-detail';
import { formatCatalogQuoteAmount } from '../../catalog/presentation/CatalogQuoteConditions.tsx';
import {
  AlibabaCatalogPricingBlock,
  DEFAULT_ALIBABA_PRICING_LABELS,
  alibabaPriceSummary,
  formatMinorAmount,
} from './AlibabaCatalogPricingBlock.tsx';
import { QuantityTierPricingBlock, quantityTierPriceSummary } from './QuantityTierPricingBlock.tsx';
import { formatPrice } from './api.ts';
import { effectiveCatalogPricing, readPriceSummary } from './catalog-pricing.ts';

/** "$7.67" for USD/CNY like every other card; "EUR 7.67" like the product page otherwise. */
function formatSummaryAmount(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  return code === 'USD' || code === 'CNY'
    ? formatMinorAmount(amountMinor, code)
    : formatCatalogQuoteAmount(amountMinor, currency);
}

/** Card text for an approved product: the lowest orderable price, or the quote label. */
function summaryCardPrice(summary: CatalogPriceSummary, quoteLabel: string): string {
  const { pricing } = summary;
  if (pricing.mode === 'negotiable' || pricing.mode === 'unavailable') return quoteLabel;
  const amount = lowestOrderableAmountMinor(pricing);
  if (amount === undefined) return quoteLabel;
  const text = formatSummaryAmount(amount, pricing.currency);
  const single =
    pricing.mode === 'fixed' ||
    (pricing.mode === 'range' && pricing.minimumAmountMinor === pricing.maximumAmountMinor);
  return single ? text : `From ${text}`;
}

export function effectiveCatalogPriceSummary(
  product: CatalogPricingInput & { priceSummary?: unknown },
  quoteLabel: string,
): string {
  const summary = readPriceSummary(product);
  if (summary) return summaryCardPrice(summary, quoteLabel);
  const decision = effectiveCatalogPricing(product);
  if (decision.source === 'manual-tiered') return quantityTierPriceSummary(decision.pricing);
  if (decision.source === 'scalar') return formatPrice(decision.amount);
  if (decision.source === 'alibaba') {
    return alibabaPriceSummary(decision.pricing) ?? DEFAULT_ALIBABA_PRICING_LABELS.unavailableLabel;
  }
  return quoteLabel;
}

/**
 * Row-page price block. An approved product normally opens the shared product
 * page; if it lands here, it shows the same summary price as its card.
 */
export function EffectiveCatalogPricingBlock({
  product,
  quoteLabel = 'Request a quote',
}: { product: CatalogPricingInput & { priceSummary?: unknown }; quoteLabel?: string }) {
  const summary = readPriceSummary(product);
  if (summary)
    return (
      <div data-effective-pricing="summary">
        <p className="font-display text-2xl font-bold text-brand-700">
          {summaryCardPrice(summary, quoteLabel)}
        </p>
      </div>
    );
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
