import type { CatalogProductDetail } from '@vibelingan-channel/shared/catalog-detail';
import { useId, useState } from 'react';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { catalogOfferView } from '../application/catalog-offer-view.ts';
import { parseCatalogQuantity } from '../application/catalog-quantity-state.ts';

// Both current adapters encode source amounts as hundredths, not ISO currency
// exponents. Preserve that contract and exact integer digits (no float divide).
export function formatCatalogQuoteAmount(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return '—';
  const amount = BigInt(amountMinor);
  return `${currency} ${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}
type Offer = CatalogProductDetail['offers'][number];
function OfferCard({
  offer,
  quantity,
  copy,
}: {
  offer: Offer | NonNullable<CatalogProductDetail['websitePricing']>;
  quantity?: number;
  copy: SharedDetailContent;
}) {
  const view = catalogOfferView(offer.pricing, quantity);
  const pricing = offer.pricing;
  const label =
    offer.basis === 'website-manual'
      ? 'Website price'
      : offer.kind === 'supplier'
        ? copy.quoteSupplierLabel
        : offer.kind === 'regular'
          ? copy.quoteRegularLabel
          : copy.quotePromotionLabel;
  const result = () => {
    switch (view.status) {
      case 'amount':
        return `${formatCatalogQuoteAmount(view.amountMinor, view.currency)} ${copy.quoteUnitLabel}`;
      case 'range':
        return `${formatCatalogQuoteAmount(view.minimumAmountMinor, view.currency)} – ${formatCatalogQuoteAmount(view.maximumAmountMinor, view.currency)} ${copy.quoteUnitLabel}`;
      case 'below-moq':
        return `${copy.quoteBelowMoq} ${copy.quoteMoqLabel}: ${view.minimum}`;
      case 'no-tier':
        return copy.quoteNoTier;
      case 'quantity-required':
        return pricing.mode === 'unavailable'
          ? copy.noSourceQuote
          : pricing.mode === 'negotiable'
            ? copy.quoteNegotiable
            : copy.quoteEnterQuantity;
      case 'negotiable':
        return copy.quoteNegotiable;
      case 'unavailable':
        return copy.noSourceQuote;
      default: {
        const exhaustive: never = view;
        return exhaustive;
      }
    }
  };
  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-4" data-source-quote={pricing.mode}>
      <p className="text-xs font-semibold text-ink-muted">{label}</p>
      {pricing.minimumOrderQuantity !== undefined && (
        <p className="mt-1 text-xs text-ink-muted">
          {copy.quoteMoqLabel}: {pricing.minimumOrderQuantity}
        </p>
      )}
      {(pricing.mode === 'fixed' || pricing.mode === 'range') &&
        view.status !== 'amount' &&
        view.status !== 'range' && (
          <p data-quote-reference-price className="mt-2 text-sm font-semibold leading-6 text-ink">
            {pricing.mode === 'fixed'
              ? formatCatalogQuoteAmount(pricing.amountMinor, pricing.currency)
              : `${formatCatalogQuoteAmount(pricing.minimumAmountMinor, pricing.currency)} – ${formatCatalogQuoteAmount(pricing.maximumAmountMinor, pricing.currency)}`}{' '}
            {copy.quoteUnitLabel}
          </p>
        )}
      <output
        data-quote-result
        className="mt-2 block text-sm font-semibold leading-6 text-ink"
        aria-live="polite"
      >
        {result()}
      </output>
      {pricing.mode === 'tiered' && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded border border-slate-100">
          <table className="w-full text-left text-xs tabular-nums">
            <caption className="sr-only">{label}</caption>
            <thead className="bg-surface-alt text-ink-muted">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {copy.quoteTierQuantityLabel}
                </th>
                <th scope="col" className="px-3 py-2">
                  {copy.quoteTierPriceLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {pricing.tiers.map((tier, index) => (
                <tr
                  key={tier.minimumQuantity}
                  data-active-tier={
                    view.status === 'amount' && view.tierIndex === index ? 'true' : undefined
                  }
                  className={
                    view.status === 'amount' && view.tierIndex === index
                      ? 'border-t border-brand-100 bg-brand-50 font-semibold text-brand-800'
                      : 'border-t border-slate-100 text-ink-soft'
                  }
                >
                  <th scope="row" className="px-3 py-3 font-medium">
                    {tier.maximumQuantity === undefined
                      ? `${tier.minimumQuantity}+`
                      : `${tier.minimumQuantity}–${tier.maximumQuantity}`}
                  </th>
                  <td className="px-3 py-3">
                    {formatCatalogQuoteAmount(tier.unitAmountMinor, pricing.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Mount key is product + approved revision. SKU changes re-evaluate the same
 * editable quantity without copying a parent offer into the selected SKU. */
export function CatalogQuoteConditions({
  productOffers,
  websitePricing,
  variantOffers,
  hasVariants = true,
  quantityDraft,
  onQuantityChange,
  copy,
}: {
  productOffers: CatalogProductDetail['offers'];
  websitePricing?: CatalogProductDetail['websitePricing'];
  variantOffers?: CatalogProductDetail['offers'];
  hasVariants?: boolean;
  quantityDraft?: string;
  onQuantityChange?: (value: string) => void;
  copy: SharedDetailContent;
}) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const currentDraft = quantityDraft ?? draft;
  const parsed = parseCatalogQuantity(currentDraft);
  const quantity = parsed.status === 'valid' ? parsed.value : undefined;
  return (
    <section data-catalog-quote-conditions className="border-t border-slate-200 pt-6">
      <h2 className="font-display text-lg font-semibold text-ink">
        {websitePricing ? 'Website pricing' : copy.sourceQuotesLabel}
      </h2>
      <label htmlFor={id} className="mb-2 mt-4 block text-sm font-medium text-ink">
        {copy.quantityLabel}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={currentDraft}
        onChange={(event) => {
          setDraft(event.target.value);
          onQuantityChange?.(event.target.value);
        }}
        aria-invalid={parsed.status === 'invalid'}
        aria-describedby={`${id}-help`}
        className="min-h-11 w-full max-w-44 rounded-lg border border-slate-300 px-3 py-2 text-base text-ink focus-visible:outline-brand-700"
      />
      <p
        id={`${id}-help`}
        className={`mt-2 text-xs leading-5 ${parsed.status === 'invalid' ? 'text-red-700' : 'text-ink-muted'}`}
      >
        {parsed.status === 'invalid'
          ? copy.quantityError
          : websitePricing
            ? 'Enter a whole number to check the applicable website price. This does not place an order.'
            : copy.quantityHelp}
      </p>
      {websitePricing && <OfferCard offer={websitePricing} quantity={quantity} copy={copy} />}
      {!websitePricing && productOffers.length > 0 && (
        <section data-quote-scope="product" className="mt-5">
          <h3 className="text-sm font-semibold">{copy.productQuoteLabel}</h3>
          {productOffers.map((offer, index) => (
            <OfferCard
              key={`${index}:${offer.kind}`}
              offer={offer}
              quantity={quantity}
              copy={copy}
            />
          ))}
        </section>
      )}
      {!websitePricing && hasVariants && (
        <section data-quote-scope="variant" className="mt-5">
          <h3 className="text-sm font-semibold">{copy.variantQuoteLabel}</h3>
          {variantOffers?.length ? (
            variantOffers.map((offer, index) => (
              <OfferCard
                key={`${index}:${offer.kind}`}
                offer={offer}
                quantity={quantity}
                copy={copy}
              />
            ))
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              {variantOffers === undefined ? copy.quoteSelectVariant : copy.noSourceQuote}
            </p>
          )}
        </section>
      )}
      {!websitePricing && !hasVariants && productOffers.length === 0 && (
        <p className="mt-4 text-sm text-ink-muted">{copy.noSourceQuote}</p>
      )}
      <p className="mt-4 text-xs leading-5 text-ink-muted">
        {websitePricing
          ? 'Website reference price. Availability, shipping and final terms require confirmation; this does not place an order.'
          : copy.pricingNote}
      </p>
    </section>
  );
}
