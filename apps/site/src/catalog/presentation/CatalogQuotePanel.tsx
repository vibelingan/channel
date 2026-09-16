import type { CatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import type {
  CatalogQuoteFields,
  CatalogQuoteTarget,
} from '@vibelingan-channel/shared/catalog-quote';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import type { VariantSelection } from '../application/catalog-variant-state.ts';
import { CatalogCompactPrice } from './CatalogCompactPrice.tsx';
import { CatalogQuoteSheet } from './CatalogQuoteSheet.tsx';
export function CatalogQuotePanel({
  detail,
  selection,
  copy,
  inquiryEnabled = true,
  children,
}: {
  detail: CatalogDetailView;
  selection: VariantSelection;
  copy: SharedDetailContent;
  inquiryEnabled?: boolean;
  children?: ReactNode;
}) {
  const [quantity, setQuantity] = useState('');
  const [intent, setIntent] = useState<CatalogQuoteFields['intent']>('variant_quote');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open || !trigger.current) return;
    const frame = requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const noVariants = detail.variants.total === 0;
  const variant = !noVariants && selection.status === 'selected' ? selection.variant : undefined;
  const pending = selection.status === 'pending' || selection.status === 'invalid';
  const blocked = !inquiryEnabled || pending || (!noVariants && !variant) || !detail.revision;
  const target: CatalogQuoteTarget = {
    productId: detail._id,
    revision: detail.revision ?? '',
    intent: noVariants ? 'customization' : intent,
    ...(variant ? { variantId: variant.id } : {}),
  };
  const launch = (button: HTMLButtonElement) => {
    if (blocked) return;
    trigger.current = button;
    setIntent(noVariants ? 'customization' : 'variant_quote');
    setOpen(true);
  };
  return (
    <>
      <CatalogCompactPrice
        productOffers={detail.offers}
        websitePricing={detail.websitePricing}
        hasVariants={detail.variants.total > 0}
        variantOffers={variant?.offers}
        copy={copy}
      />
      {children}
      <div>
        <button
          disabled={blocked}
          data-quote-open
          type="button"
          onClick={(event) => launch(event.currentTarget)}
          className="min-h-12 w-full rounded-lg bg-accent-500 px-5 py-3 text-base font-semibold text-brand-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.inquiryLabel}
        </button>
      </div>
      <CatalogQuoteSheet
        open={open}
        onClose={() => setOpen(false)}
        target={target}
        detail={detail}
        variant={variant}
        blocked={blocked}
        quantity={quantity}
        onQuantityChange={setQuantity}
        onIntentChange={setIntent}
        copy={copy}
      />
    </>
  );
}
