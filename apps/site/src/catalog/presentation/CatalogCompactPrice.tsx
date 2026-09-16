import type { CatalogProductDetail } from '@vibelingan-channel/shared/catalog-detail';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { formatCatalogQuoteAmount } from './CatalogQuoteConditions.tsx';

type Offer = CatalogProductDetail['offers'][number];
type WebsitePricing = NonNullable<CatalogProductDetail['websitePricing']>;

function referenceAmount(pricing: Offer['pricing']): string | undefined {
  const valid = (amount: number) => Number.isSafeInteger(amount) && amount >= 0;
  if (pricing.mode === 'unavailable' || pricing.mode === 'negotiable') return undefined;
  let minimum: number;
  let maximum: number;
  if (pricing.mode === 'fixed') {
    minimum = maximum = pricing.amountMinor;
  } else if (pricing.mode === 'range') {
    minimum = pricing.minimumAmountMinor;
    maximum = pricing.maximumAmountMinor;
  } else {
    const amounts = pricing.tiers.map((tier) => tier.unitAmountMinor).filter(valid);
    if (!amounts.length) return undefined;
    minimum = Math.min(...amounts);
    maximum = Math.max(...amounts);
  }
  if (!valid(minimum) || !valid(maximum) || minimum > maximum) return undefined;
  const from = formatCatalogQuoteAmount(minimum, pricing.currency);
  return minimum === maximum
    ? from
    : `${from} - ${formatCatalogQuoteAmount(maximum, pricing.currency)}`;
}

function PriceReference({
  offer,
  copy,
}: { offer: Offer | WebsitePricing; copy: SharedDetailContent }) {
  const amount = referenceAmount(offer.pricing);
  const label =
    offer.basis === 'website-manual'
      ? 'Website price'
      : offer.kind === 'supplier'
        ? copy.quoteSupplierLabel
        : offer.kind === 'regular'
          ? copy.quoteRegularLabel
          : copy.quotePromotionLabel;
  return (
    <div className="min-w-0">
      <p className="text-xs text-ink-muted">
        {label}
        {amount ? ' / Reference' : ''}
      </p>
      <p className="mt-1 break-words text-xl font-semibold leading-snug tabular-nums text-brand-950">
        {amount ?? copy.inquiryLabel}
        {amount && (
          <span className="text-sm font-normal text-ink-muted"> {copy.quoteUnitLabel}</span>
        )}
      </p>
    </div>
  );
}

export function CatalogCompactPrice({
  productOffers,
  websitePricing,
  variantOffers,
  hasVariants,
  copy,
}: {
  productOffers: CatalogProductDetail['offers'];
  websitePricing?: CatalogProductDetail['websitePricing'];
  variantOffers?: CatalogProductDetail['offers'];
  hasVariants: boolean;
  copy: SharedDetailContent;
}) {
  const scope = (name: 'product' | 'variant', offers: Offer[], label: string) => (
    <section data-quote-scope={name} className="min-w-0 space-y-2">
      <h2 className="text-xs font-medium text-ink-muted">{label}</h2>
      {offers.length ? (
        offers.map((offer, index) => (
          <PriceReference key={`${index}:${offer.kind}`} offer={offer} copy={copy} />
        ))
      ) : (
        <p className="text-xl font-semibold text-brand-950">{copy.inquiryLabel}</p>
      )}
    </section>
  );
  return (
    <div data-catalog-compact-price className="min-w-0 space-y-3" aria-live="polite">
      {websitePricing ? (
        <PriceReference offer={websitePricing} copy={copy} />
      ) : (
        <>
          {(productOffers.length > 0 || !hasVariants) &&
            scope('product', productOffers, copy.productQuoteLabel)}
          {hasVariants &&
            variantOffers !== undefined &&
            scope('variant', variantOffers, copy.variantQuoteLabel)}
          {hasVariants && variantOffers === undefined && productOffers.length === 0 && (
            <p className="text-xl font-semibold text-brand-950">{copy.inquiryLabel}</p>
          )}
        </>
      )}
    </div>
  );
}
