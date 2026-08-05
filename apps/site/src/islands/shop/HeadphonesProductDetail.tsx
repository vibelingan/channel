/**
 * Presentational Headphones product detail (MIU 11).
 *
 * Renders the Gallery media contract, the spec sheet, the existing PriceBlock
 * entitlement behavior, a programmatically focusable heading, and a Back
 * button. Every enquiry command is a plain anchor to the homepage OEM enquiry
 * section — no modal, no login prerequisite, no simulated durable success.
 *
 * Both detail columns are `min-w-0` tracks so long titles, descriptions, and
 * spec values wrap inside the 768–1024px layouts instead of clipping or
 * widening the page. Focus movement (heading focus after expansion, card
 * focus restoration on Back) belongs to the MIU 13 controller.
 */
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';
import { Gallery } from './Gallery.tsx';
import { PriceBlock } from './PriceBlock.tsx';
import { formatPrice } from './api.ts';
import type { Product } from './catalog-types.ts';

export interface HeadphonesProductDetailProps {
  product: Product;
  detail: HeadphonesContent['detail'];
  /** Category display label, resolved by the caller from the list contract. */
  categoryLabel: string;
  registered: boolean;
  onBack: () => void;
}

export function HeadphonesProductDetail({
  product,
  detail,
  categoryLabel,
  registered,
  onBack,
}: HeadphonesProductDetailProps) {
  return (
    <section
      data-product-detail={product._id}
      className="border-t border-slate-200 bg-surface-alt py-16 sm:py-20"
    >
      <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          data-detail-back
          onClick={onBack}
          className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-soft transition hover:text-brand-700"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {detail.backToModelsLabel}
        </button>

        <div className="grid gap-10 lg:grid-cols-2">
          <div className="min-w-0">
            <Gallery
              images={product.images ?? []}
              alt={product.name}
              productId={product._id}
              viewAllLabel={detail.viewAllLabel}
              showLessLabel={detail.showLessLabel}
              unavailableLabel={detail.imageUnavailableLabel}
            />
          </div>

          <div className="min-w-0">
            <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
              {categoryLabel}
            </span>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the MIU 13 controller moves focus here after in-page expansion. */}
            <h2
              tabIndex={-1}
              data-detail-heading
              className="mt-3 break-words font-display text-3xl font-bold text-ink outline-none"
            >
              {product.name}
            </h2>
            {product.modName && (
              <p className="mt-1 text-sm font-medium uppercase tracking-wide text-ink-muted">
                {product.modName}
              </p>
            )}
            {product.description && (
              <p className="mt-4 break-words text-base leading-relaxed text-ink-soft">
                {product.description}
              </p>
            )}

            <dl className="mt-6 divide-y divide-slate-100 rounded-[var(--radius-card)] border border-slate-200 bg-white">
              {product.series && (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-sm text-ink-muted">{detail.seriesLabel}</dt>
                  <dd className="min-w-0 break-words text-right text-sm font-semibold text-ink">
                    {product.series}
                  </dd>
                </div>
              )}
              {product.modType && (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-sm text-ink-muted">{detail.typeLabel}</dt>
                  <dd className="min-w-0 break-words text-right text-sm font-semibold text-ink">
                    {product.modType}
                  </dd>
                </div>
              )}
              {product.moq !== undefined && (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-sm text-ink-muted">{detail.moqLabel}</dt>
                  <dd className="text-sm font-semibold text-ink">{product.moq}</dd>
                </div>
              )}
              {product.unitPrice !== undefined && (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-sm text-ink-muted">{detail.unitPriceLabel}</dt>
                  <dd className="font-display text-base font-bold text-brand-700">
                    {formatPrice(product.unitPrice)}
                  </dd>
                </div>
              )}
              {product.productCode && (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-sm text-ink-muted">Product Code</dt>
                  <dd className="min-w-0 break-words text-right text-sm font-medium text-ink">
                    {product.productCode}
                  </dd>
                </div>
              )}
            </dl>

            <div className="mt-6 rounded-[var(--radius-card)] bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <PriceBlock
                wholesaleLabel={detail.wholesaleLabel}
                vipLabel={detail.vipLabel}
                vipLockedLabel={detail.vipLockedLabel}
                wholesalePrice={product.wholesalePrice}
                vipPrice={product.vipPrice}
                registered={registered}
                size="lg"
              />
            </div>

            <div className="mt-6">
              <a
                href={OEM_INQUIRY_HREF}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-6 py-3.5 text-base font-semibold text-brand-950 shadow-sm transition hover:bg-accent-400 sm:w-auto"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 8l9 6 9-6M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z"
                  />
                </svg>
                {detail.inquiryCta}
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
