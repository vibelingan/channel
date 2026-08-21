import type { ManualCatalogPricing } from '@vibelingan-channel/shared';

function formatMinorAmount(
  amountMinor: number,
  currency: ManualCatalogPricing['currency'],
): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function quantityRange(minQuantity: number, maxQuantity: number | undefined): string {
  return maxQuantity === undefined ? `${minQuantity}+` : `${minQuantity}–${maxQuantity}`;
}

export function quantityTierPriceSummary(pricing: ManualCatalogPricing): string {
  const lowestAmount = Math.min(...pricing.tiers.map((tier) => tier.unitAmountMinor));
  return `From ${formatMinorAmount(lowestAmount, pricing.currency)}`;
}

export function QuantityTierPricingBlock({ pricing }: { pricing: ManualCatalogPricing }) {
  return (
    <div data-manual-tier-pricing>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
        Quantity pricing ({pricing.currency})
      </p>
      <p className="mt-2 font-display text-3xl font-bold text-brand-700">
        {quantityTierPriceSummary(pricing)}
      </p>
      <table className="mt-4 w-full border-collapse text-sm">
        <thead className="sr-only">
          <tr>
            <th scope="col">Quantity</th>
            <th scope="col">Unit price</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {pricing.tiers.map((tier) => (
            <tr key={tier.minQuantity}>
              <th scope="row" className="py-2 text-left font-medium text-ink-soft">
                {quantityRange(tier.minQuantity, tier.maxQuantity)}
              </th>
              <td className="py-2 text-right font-semibold text-ink">
                {formatMinorAmount(tier.unitAmountMinor, pricing.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
