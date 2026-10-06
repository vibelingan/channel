import type { CatalogProductDetail } from '@vibelingan-channel/shared/catalog-detail';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { formatCatalogQuoteAmount } from './CatalogQuoteConditions.tsx';

type Offer = CatalogProductDetail['offers'][number];

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
    // stays visible so no unquoted quantity appears covered. Quantities below
    // the minimum order cannot be ordered, so they are never shown as windows.
    const moq = pricing.minimumOrderQuantity;
    const windows: Array<{ minimum: number; maximum?: number; amount: number }> = [];
    for (const tier of pricing.tiers) {
      if (!valid(tier.unitAmountMinor)) continue;
      if (moq !== undefined && tier.maximumQuantity !== undefined && tier.maximumQuantity < moq)
        continue;
      const minimum =
        moq !== undefined ? Math.max(tier.minimumQuantity, moq) : tier.minimumQuantity;
      const previous = windows.at(-1);
      if (
        previous?.amount === tier.unitAmountMinor &&
        previous.maximum !== undefined &&
        previous.maximum + 1 === minimum
      ) {
        previous.maximum = tier.maximumQuantity;
        continue;
      }
      windows.push({ minimum, maximum: tier.maximumQuantity, amount: tier.unitAmountMinor });
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

function offerLabel(offer: Offer, copy: SharedDetailContent) {
  return offer.kind === 'supplier'
    ? copy.quoteSupplierLabel
    : offer.kind === 'regular'
      ? copy.quoteRegularLabel
      : copy.quotePromotionLabel;
}

function PriceTiers({ pairs, copy }: { pairs: PricePair[]; copy: SharedDetailContent }) {
  return (
    <ul className="flex flex-wrap gap-x-8 gap-y-3">
      {pairs.map((pair) => (
        <li key={`${pair.amount}:${pair.quantity}`} data-price-tier className="min-w-0">
          <p className="break-words text-[28px] font-semibold leading-9 tabular-nums text-brand-950">
            {pair.amount}
          </p>{' '}
          <p className="mt-1 text-sm leading-5 tabular-nums text-ink-muted">
            {pair.quantity ?? copy.quoteUnitLabel}
          </p>
        </li>
      ))}
    </ul>
  );
}

const inquiry = (copy: SharedDetailContent) => (
  <p className="text-xl font-semibold leading-snug text-brand-950">{copy.inquiryLabel}</p>
);

/** One price block: website price, else the selected configuration's own
 * quote, else the product quote. A configuration whose own quote is unknown
 * says so instead of silently adopting the product price. */
export function CatalogCompactPrice({
  productOffers,
  websitePricing,
  variantOffers,
  copy,
}: {
  productOffers: CatalogProductDetail['offers'];
  websitePricing?: CatalogProductDetail['websitePricing'];
  variantOffers?: CatalogProductDetail['offers'];
  copy: SharedDetailContent;
}) {
  const priced = (offers: Offer[]) =>
    offers
      .map((offer) => ({ offer, pairs: pricePairs(offer.pricing, copy) }))
      .filter(({ pairs }) => pairs.length > 0);
  const variant = priced(variantOffers ?? []);
  const product = priced(productOffers);
  const scope = variant.length ? 'variant' : product.length ? 'product' : undefined;
  const shown = variant.length ? variant : product;
  const variantUnknown = !variant.length && Boolean(variantOffers?.length) && product.length > 0;
  return (
    <div data-catalog-compact-price className="min-w-0 space-y-3 font-sans" aria-live="polite">
      {websitePricing ? (
        (() => {
          const pairs = pricePairs(websitePricing.pricing, copy);
          return pairs.length ? <PriceTiers pairs={pairs} copy={copy} /> : inquiry(copy);
        })()
      ) : scope ? (
        <div data-quote-scope={scope} className="min-w-0 space-y-3">
          {shown.map(({ offer, pairs }, index) => (
            <div key={`${index}:${offer.kind}`} className="min-w-0">
              {shown.length > 1 && (
                <p className="mb-1 text-xs text-ink-muted">{offerLabel(offer, copy)}</p>
              )}
              <PriceTiers pairs={pairs} copy={copy} />
            </div>
          ))}
          {variantUnknown && (
            <p data-variant-price-unknown className="text-sm text-ink-muted">
              {copy.variantPriceOnRequest}
            </p>
          )}
        </div>
      ) : (
        inquiry(copy)
      )}
    </div>
  );
}
