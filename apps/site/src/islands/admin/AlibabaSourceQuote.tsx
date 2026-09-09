import { decodeAlibabaSourceReview, formatAlibabaSourcePricing } from './alibaba-source-review.ts';

/** Read-only source quotation. Never writes a representative SKU's price into website overrides. */
export function AlibabaSourceQuote({ value }: { value: unknown }) {
  const review = decodeAlibabaSourceReview(value);
  if (!review) return null;
  const pricing = review.primaryPricing;
  return (
    <section
      aria-label="Synced source quote"
      className="rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm"
    >
      <h3 className="font-semibold text-slate-900">Synced source quote</h3>
      <p className="mt-2 text-slate-600">
        Already synchronized from Alibaba; no manual re-entry is required. This is a representative
        source quotation; individual configurations may differ.
      </p>
      {review.minimumOrderQuantity !== undefined && (
        <p className="mt-3">
          Source MOQ: <strong>{review.minimumOrderQuantity}</strong>
        </p>
      )}
      {pricing?.mode === 'tiered' ? (
        <table className="mt-3 w-full text-left">
          <caption className="sr-only">Source quantity price tiers</caption>
          <thead>
            <tr>
              <th scope="col" className="py-2">
                Quantity
              </th>
              <th scope="col">Source unit quote</th>
            </tr>
          </thead>
          <tbody>
            {pricing.tiers.map((tier) => (
              <tr key={tier.minimumQuantity} className="border-t border-brand-200">
                <td className="py-2">
                  {tier.maximumQuantity === undefined
                    ? `${tier.minimumQuantity}+`
                    : `${tier.minimumQuantity}–${tier.maximumQuantity}`}
                </td>
                <td>
                  {pricing.currency} {(tier.unitAmountMinor / 100).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-3 font-semibold">{formatAlibabaSourcePricing(pricing)}</p>
      )}
      <p className="mt-3 text-xs text-slate-600">
        Source evidence only. The effective website price is shown separately. Manual website edits
        do not change Alibaba.
      </p>
    </section>
  );
}
