import type { CatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import type {
  CatalogQuoteFields,
  CatalogQuoteTarget,
} from '@vibelingan-channel/shared/catalog-quote';
import { useContext, useRef, useState } from 'react';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { CatalogLocalPreviewContext } from '../application/catalog-quote-transport.ts';
import type { VariantSelection } from '../application/catalog-variant-state.ts';
import { CatalogQuoteConditions } from './CatalogQuoteConditions.tsx';
import { CatalogQuoteSheet } from './CatalogQuoteSheet.tsx';
export function CatalogQuotePanel({
  detail,
  selection,
  copy,
}: { detail: CatalogDetailView; selection: VariantSelection; copy: SharedDetailContent }) {
  const [quantity, setQuantity] = useState('');
  const localPreview = useContext(CatalogLocalPreviewContext);
  const [intent, setIntent] = useState<CatalogQuoteFields['intent']>('variant_quote');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const variant = selection.status === 'selected' ? selection.variant : undefined;
  const pending =
    selection.status === 'pending' ||
    selection.status === 'invalid' ||
    selection.status === 'unselected';
  const target: CatalogQuoteTarget = {
    productId: detail._id,
    revision: detail.revision ?? '',
    intent,
    ...(variant ? { variantId: variant.id } : {}),
  };
  const launch = (next: CatalogQuoteFields['intent'], button: HTMLButtonElement) => {
    trigger.current = button;
    setIntent(next);
    setOpen(true);
  };
  return (
    <>
      <CatalogQuoteConditions
        productOffers={detail.offers}
        websitePricing={detail.websitePricing}
        hasVariants={detail.variants.total > 0}
        variantOffers={variant?.offers}
        copy={copy}
        quantityDraft={quantity}
        onQuantityChange={setQuantity}
      />
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <button
          disabled={pending || !variant || !detail.revision}
          data-quote-open
          type="button"
          onClick={(event) => launch('variant_quote', event.currentTarget)}
          className="min-h-12 w-full rounded-lg bg-accent-500 px-5 py-3 text-base font-semibold text-brand-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.inquiryLabel}
        </button>
        <button
          disabled={pending || !detail.revision}
          type="button"
          onClick={(event) => launch('customization', event.currentTarget)}
          className="mt-3 min-h-11 w-full rounded-lg border border-brand-200 px-4 py-2 text-sm font-semibold text-brand-700 disabled:opacity-50"
        >
          {copy.rfq.customizationAction}
        </button>
        {localPreview && (
          <p className="mt-3 text-xs leading-5 text-ink-muted">{copy.rfq.localNotice}</p>
        )}
      </div>
      <CatalogQuoteSheet
        open={open}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        target={target}
        detail={detail}
        variant={variant}
        blocked={pending}
        quantity={quantity}
        onQuantityChange={setQuantity}
        copy={copy}
      />
    </>
  );
}
