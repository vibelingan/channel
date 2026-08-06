/**
 * Presentational Headphones catalog card (MIU 10).
 *
 * A semantic in-page expansion button: activating it opens the product's
 * detail section on the same page (wired by the MIU 13 controller), so it is
 * a `<button>`, never a link. Media flows through ProductMedia's ordered
 * source/fallback contract — lazy and low-priority so a page of cards does
 * not stampede the gated image function.
 *
 * Hierarchy is calibrated and browser-asserted: product identity strongest,
 * unit price display 14px/600 (`text-sm font-semibold`), the view-details
 * action 12px/500 (`text-xs font-medium`).
 */
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { alibabaPriceSummary } from './AlibabaCatalogPricingBlock.tsx';
import { ProductMedia } from './ProductMedia.tsx';
import { formatPrice } from './api.ts';
import type { Product } from './catalog-types.ts';

export interface HeadphonesProductCardProps {
  product: Product;
  list: HeadphonesContent['list'];
  imageUnavailableLabel: string;
  onOpen: (productId: string) => void;
}

export function HeadphonesProductCard({
  product,
  list,
  imageUnavailableLabel,
  onOpen,
}: HeadphonesProductCardProps) {
  return (
    <button
      type="button"
      data-product-card={product._id}
      onClick={() => onOpen(product._id)}
      className="group relative flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-[var(--shadow-card)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
    >
      <div className="relative aspect-square overflow-hidden bg-white">
        <ProductMedia
          sources={product.images ?? []}
          alt={product.name}
          unavailableLabel={imageUnavailableLabel}
          loading="lazy"
          fetchPriority="low"
          imageClassName="p-6 transition duration-300 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      </div>

      <div className="flex flex-1 flex-col border-t border-slate-100 p-4">
        <h4 className="font-display text-base font-semibold text-ink group-hover:text-brand-700">
          {product.name}
        </h4>
        {product.modName && (
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
            {product.modName}
          </p>
        )}
        {product.description && (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-ink-soft">
            {product.description}
          </p>
        )}

        <div className="mt-auto pt-4">
          <div className="flex items-center justify-between text-xs text-ink-muted">
            {/* Alibaba-linked cards (MIU 10) route by LINK IDENTITY: the
                legacy moq/unitPrice values are suppressed and the live source
                summary (or nothing, for quote-required states) renders. */}
            {product.alibabaPrimarySourceKey ? (
              <>
                {product.alibabaCatalogPricing?.sourceMoq !== undefined && (
                  <span data-alibaba-card-moq>
                    {list.moqLabel}: <strong>{product.alibabaCatalogPricing.sourceMoq}</strong>
                  </span>
                )}
                {alibabaPriceSummary(product.alibabaCatalogPricing) !== null && (
                  <span data-alibaba-card-price className="text-sm font-semibold text-brand-700">
                    {alibabaPriceSummary(product.alibabaCatalogPricing)}
                  </span>
                )}
              </>
            ) : (
              <>
                {product.moq !== undefined && (
                  <span>
                    {list.moqLabel}: <strong>{product.moq}</strong>
                  </span>
                )}
                {product.unitPrice !== undefined && (
                  <span data-product-card-price className="text-sm font-semibold text-brand-700">
                    {formatPrice(product.unitPrice)}
                  </span>
                )}
              </>
            )}
          </div>
          <div
            data-product-card-action
            className="mt-3 flex items-center gap-1.5 text-xs font-medium text-brand-600 transition group-hover:text-brand-700"
          >
            {list.viewDetail}
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </div>
      </div>
    </button>
  );
}
