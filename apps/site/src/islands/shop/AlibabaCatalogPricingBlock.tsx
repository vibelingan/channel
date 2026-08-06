/**
 * Live Alibaba source pricing renderer (docs/alibaba-linked-catalog-sync,
 * MIU 10). Rendered INSTEAD of the legacy pricing surfaces whenever
 * `product.alibabaPrimarySourceKey` is set — a linked product never falls
 * back to `unitPrice`/`wholesalePrice`/`vipPrice`, including when source
 * pricing is missing (the quote-required state renders instead).
 *
 * Amounts are integer MINOR units with an explicit CNY/USD currency; the
 * legacy `formatPrice` (major-unit floats, hardcoded USD) is never used here.
 * Labels default to English and are overridable via props until the
 * headphones i18n content grows an alibaba group (typed-content follow-up).
 */
import type { ReactNode } from 'react';
import type { AlibabaCatalogPricing } from './catalog-types.ts';

export interface AlibabaPricingLabels {
  heading: string;
  tierQuantityLabel: string;
  tierPriceLabel: string;
  negotiableLabel: string;
  unavailableLabel: string;
  moqLabel: string;
  updatedLabel: string;
}

export const DEFAULT_ALIBABA_PRICING_LABELS: AlibabaPricingLabels = {
  heading: 'Live source pricing',
  tierQuantityLabel: 'Quantity',
  tierPriceLabel: 'Unit price',
  negotiableLabel: 'Price on request',
  unavailableLabel: 'Pricing unavailable — request a quote',
  moqLabel: 'Source MOQ',
  updatedLabel: 'Updated',
};

/** Display formatter for integer minor units; NOT for arithmetic. */
export function formatMinorAmount(amountMinor: number, currency: 'CNY' | 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

/**
 * Compact one-line summary for card badges: "$2.50", "$1.50 – $2.30",
 * "From $1.15" (tiered), or null when nothing displayable exists
 * (negotiable/unavailable/malformed) — callers render their unavailable copy.
 */
export function alibabaPriceSummary(pricing: AlibabaCatalogPricing | undefined): string | null {
  if (!pricing || !pricing.currency) return null;
  switch (pricing.mode) {
    case 'fixed':
      return pricing.amountMinor !== undefined
        ? formatMinorAmount(pricing.amountMinor, pricing.currency)
        : null;
    case 'range':
      return pricing.minAmountMinor !== undefined && pricing.maxAmountMinor !== undefined
        ? `${formatMinorAmount(pricing.minAmountMinor, pricing.currency)} – ${formatMinorAmount(pricing.maxAmountMinor, pricing.currency)}`
        : null;
    case 'tiered': {
      const amounts = (pricing.tiers ?? []).map((tier) => tier.unitAmountMinor);
      if (amounts.length === 0) return null;
      return `From ${formatMinorAmount(Math.min(...amounts), pricing.currency)}`;
    }
    default:
      return null;
  }
}

interface Props {
  pricing?: AlibabaCatalogPricing | undefined;
  labels?: Partial<AlibabaPricingLabels>;
  size?: 'sm' | 'lg';
}

export function AlibabaCatalogPricingBlock({ pricing, labels, size = 'sm' }: Props) {
  const copy = { ...DEFAULT_ALIBABA_PRICING_LABELS, ...labels };
  const priceClass = size === 'lg' ? 'text-3xl' : 'text-xl';
  const mode = pricing?.mode ?? 'unavailable';
  const currency = pricing?.currency;

  let bodyContent: ReactNode;
  if (mode === 'fixed' && pricing?.amountMinor !== undefined && currency) {
    bodyContent = (
      <p className={`font-display font-bold text-brand-700 ${priceClass}`} data-alibaba-amount>
        {formatMinorAmount(pricing.amountMinor, currency)}
      </p>
    );
  } else if (
    mode === 'range' &&
    pricing?.minAmountMinor !== undefined &&
    pricing?.maxAmountMinor !== undefined &&
    currency
  ) {
    bodyContent = (
      <p className={`font-display font-bold text-brand-700 ${priceClass}`} data-alibaba-amount>
        {formatMinorAmount(pricing.minAmountMinor, currency)}
        <span className="px-1 text-ink-muted">–</span>
        {formatMinorAmount(pricing.maxAmountMinor, currency)}
      </p>
    );
  } else if (mode === 'tiered' && (pricing?.tiers?.length ?? 0) > 0 && currency) {
    bodyContent = (
      <table className="w-full text-sm" data-alibaba-tiers>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
            <th className="py-1 pr-4 font-medium">{copy.tierQuantityLabel}</th>
            <th className="py-1 font-medium">{copy.tierPriceLabel}</th>
          </tr>
        </thead>
        <tbody>
          {(pricing?.tiers ?? []).map((tier) => (
            <tr key={tier.minQuantity} className="border-t border-slate-100">
              <td className="py-1.5 pr-4 text-ink-soft">
                {tier.maxQuantity !== undefined
                  ? `${tier.minQuantity} – ${tier.maxQuantity}`
                  : `${tier.minQuantity}+`}
              </td>
              <td className="py-1.5 font-semibold text-brand-700">
                {formatMinorAmount(tier.unitAmountMinor, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (mode === 'negotiable') {
    bodyContent = (
      <p className="text-sm font-medium text-ink-soft" data-alibaba-negotiable>
        {copy.negotiableLabel}
      </p>
    );
  } else {
    // 'unavailable', missing pricing, or a malformed shape: the quote-required
    // state — NEVER a legacy-price fallback.
    bodyContent = (
      <p className="text-sm font-medium text-ink-soft" data-alibaba-unavailable>
        {copy.unavailableLabel}
      </p>
    );
  }

  return (
    <div data-alibaba-pricing data-mode={mode}>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{copy.heading}</p>
      <div className="mt-2">{bodyContent}</div>
      {(pricing?.sourceMoq !== undefined || pricing?.sourceUpdatedAt !== undefined) && (
        <p className="mt-2 text-xs text-ink-muted">
          {pricing?.sourceMoq !== undefined && (
            <span data-alibaba-moq>
              {copy.moqLabel}: <strong>{pricing.sourceMoq}</strong>
            </span>
          )}
          {pricing?.sourceMoq !== undefined && pricing?.sourceUpdatedAt !== undefined && (
            <span className="px-1" aria-hidden="true">
              ·
            </span>
          )}
          {pricing?.sourceUpdatedAt !== undefined && (
            <span data-alibaba-updated>
              {copy.updatedLabel}: {pricing.sourceUpdatedAt.slice(0, 10)}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
