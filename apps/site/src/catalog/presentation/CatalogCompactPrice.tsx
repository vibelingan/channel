import type { CatalogProductDetail } from '@vibelingan-channel/shared/catalog-detail';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { formatCatalogQuoteAmount } from './CatalogQuoteConditions.tsx';

type Offer = CatalogProductDetail['offers'][number];
type WebsitePricing = NonNullable<CatalogProductDetail['websitePricing']>;

const valid = (amount: number) => Number.isSafeInteger(amount) && amount >= 0;

type PricePair = { amount: string; quantity?: string };

function pricePairs(pricing: Offer['pricing'], copy: SharedDetailContent): PricePair[] {
  if (pricing.mode === 'unavailable' || pricing.mode === 'negotiable') return [];
  const count = (value: number) => value.toLocaleString('en-US');
  const pieces = (value: number) =>
    `${count(value)} ${value === 1 ? copy.quotePieceLabel : copy.quotePiecesLabel}`;
  const atLeast = (value: number) => `≥${pieces(value)}`;
  const format = (amount: number) => formatCatalogQuoteAmount(amount, pricing.currency);
  if (pricing.mode === 'tiered') {
    // Contiguous tiers at one price read as one window; a gap between them
    // stays visible so no unquoted quantity appears covered.
    const windows: Array<{ minimum: number; maximum?: number; amount: number }> = [];
    for (const tier of pricing.tiers) {
      if (!valid(tier.unitAmountMinor)) continue;
      const previous = windows.at(-1);
      if (
        previous?.amount === tier.unitAmountMinor &&
        previous.maximum !== undefined &&
        previous.maximum + 1 === tier.minimumQuantity
      ) {
        previous.maximum = tier.maximumQuantity;
        continue;
      }
      windows.push({
        minimum: tier.minimumQuantity,
        maximum: tier.maximumQuantity,
        amount: tier.unitAmountMinor,
      });
    }
    return windows.map(({ minimum, maximum, amount }) => ({
      amount: format(amount),
      quantity:
        maximum === undefined
          ? atLeast(minimum)
          : maximum === minimum
            ? pieces(minimum)
            : `${count(minimum)}-${pieces(maximum)}`,
    }));
  }
  let amount: string;
  if (pricing.mode === 'fixed') {
    if (!valid(pricing.amountMinor)) return [];
    amount = format(pricing.amountMinor);
  } else {
    const { minimumAmountMinor: minimum, maximumAmountMinor: maximum } = pricing;
    if (!valid(minimum) || !valid(maximum) || minimum > maximum) return [];
    amount = minimum === maximum ? format(minimum) : `${format(minimum)} - ${format(maximum)}`;
  }
  return [
    {
      amount,
      ...(pricing.minimumOrderQuantity === undefined
        ? {}
        : { quantity: atLeast(pricing.minimumOrderQuantity) }),
    },
  ];
}

function PriceReference({
  offer,
  copy,
}: { offer: Offer | WebsitePricing; copy: SharedDetailContent }) {
  const pairs = pricePairs(offer.pricing, copy);
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
        {pairs.length ? ' / Reference' : ''}
      </p>
      {pairs.length ? (
        <ul className="mt-1 flex flex-wrap gap-x-8 gap-y-3">
          {pairs.map((pair) => (
            <li key={`${pair.amount}:${pair.quantity}`} data-price-tier className="min-w-0">
              <p className="break-words text-[28px] font-semibold leading-9 tabular-nums text-brand-950">
                {pair.amount}
              </p>{' '}
              <p className="text-sm leading-5 tabular-nums text-ink-muted">
                {pair.quantity ?? copy.quoteUnitLabel}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 break-words text-xl font-semibold leading-snug text-brand-950">
          {copy.inquiryLabel}
        </p>
      )}
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
      <h2 className="font-sans text-xs font-medium text-ink-muted">{label}</h2>
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
    <div data-catalog-compact-price className="min-w-0 space-y-3 font-sans" aria-live="polite">
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
