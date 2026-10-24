import { apiMediaUrl } from '../../lib/api-url.ts';
import { PriceBlock } from './PriceBlock.tsx';
import { StockBadge } from './StockBadge.tsx';
import type { Product } from './api.ts';
import { useInquiryCart } from './inquiryCart.ts';
import type { CatalogConfig, CatalogListStrings } from './types.ts';

interface Props {
  product: Product;
  content: CatalogListStrings;
  config: CatalogConfig;
  registered: boolean;
}

/** eBay-style product card for the catalog grid. Reused by every catalog. */
export function ProductCard({ product, content, config, registered }: Props) {
  const href = `${config.detailPath}?id=${encodeURIComponent(product._id)}`;
  const image = apiMediaUrl(product.images?.[0] ?? config.fallbackImage);
  const categoryLabel =
    content.categories.find((c) => c.key === product.category)?.label ?? product.category;
  const cart = useInquiryCart();
  const inCart = cart.has(product._id);

  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-[var(--shadow-card)]">
      <a href={href} className="flex flex-1 flex-col">
        <div className="relative aspect-square overflow-hidden bg-surface-alt">
          <img
            src={image}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
          <span className="absolute left-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-brand-700 shadow-sm">
            {categoryLabel}
          </span>
          {config.showStock && (
            <span className="absolute right-3 top-3">
              <StockBadge
                inventory={product.inventory}
                labels={{
                  available: content.statusAvailable,
                  low: content.statusLow,
                  soldOut: content.statusSoldOut,
                }}
              />
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col p-4">
          <h3 className="font-display text-base font-semibold text-ink group-hover:text-brand-700">
            {product.name}
          </h3>
          {product.description && (
            <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink-soft">
              {product.description}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            {(product.modName || product.productCode) && (
              <span className="font-medium text-ink-soft">
                {product.modName ?? product.productCode}
              </span>
            )}
            {product.moq !== undefined && (
              <span>
                · {content.moqLabel} {product.moq}
              </span>
            )}
          </div>

          <div className="mt-auto pt-4">
            <PriceBlock
              wholesaleLabel={content.wholesaleLabel}
              vipLabel={content.vipLabel}
              vipLockedLabel={content.vipLockedLabel}
              wholesalePrice={product.wholesalePrice}
              vipPrice={product.vipPrice}
              registered={registered}
              signInHref={null}
            />
          </div>
        </div>
      </a>

      {config.enableCart && (
        <div className="border-t border-slate-100 p-3">
          <button
            type="button"
            onClick={() =>
              inCart
                ? cart.remove(product._id)
                : cart.add({
                    id: product._id,
                    name: product.name,
                    image,
                    code: product.productCode,
                  })
            }
            className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              inCart
                ? 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                : 'bg-brand-700 text-white hover:bg-brand-800'
            }`}
          >
            {inCart ? (
              <>
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {content.inInquiry ?? 'Added'}
              </>
            ) : (
              <>
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
                </svg>
                {content.addToInquiry ?? 'Add to inquiry'}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
