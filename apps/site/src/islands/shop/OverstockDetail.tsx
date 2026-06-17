import { useEffect, useState } from 'react';
import type { OverstockContent } from '../../i18n/overstock.ts';
import { Gallery } from './Gallery.tsx';
import { InquiryCartBar } from './InquiryCartBar.tsx';
import { InquiryForm } from './InquiryForm.tsx';
import { StockBadge } from './StockBadge.tsx';
import { type Product, fetchCatalogItem, formatPrice, stockStatus } from './api.ts';
import { useInquiryCart } from './inquiryCart.ts';
import { useSession } from './session.ts';

interface Props {
  content: OverstockContent;
  apiPath: string;
}

function getId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('id') ?? '';
}

/** Overstock detail island: gallery + clearance-focused pricing + batch inquiry. */
export function OverstockDetail({ content, apiPath }: Props) {
  const { detail, list, inquiry } = content;
  const [product, setProduct] = useState<Product | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  const [showInquiry, setShowInquiry] = useState(false);
  const { canSeeVip, loggedIn } = useSession();
  const cart = useInquiryCart();

  useEffect(() => {
    const id = getId();
    if (!id) {
      setStatus('not-found');
      return;
    }
    fetchCatalogItem(apiPath, id)
      .then((p) => {
        setProduct(p);
        setStatus('ready');
      })
      .catch((e) =>
        setStatus(e instanceof Error && e.message === 'not-found' ? 'not-found' : 'error'),
      );
  }, [apiPath]);

  if (status === 'loading') {
    return (
      <div className="grid gap-10 lg:grid-cols-2">
        <div className="aspect-square animate-pulse rounded-[var(--radius-card)] bg-slate-100" />
        <div className="space-y-4">
          <div className="h-8 w-2/3 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-slate-100" />
        </div>
      </div>
    );
  }

  if (status === 'not-found' || status === 'error' || !product) {
    return (
      <div className="rounded-[var(--radius-card)] border border-slate-200 bg-surface-alt p-12 text-center">
        <p className="text-ink-soft">{detail.notFound}</p>
        <a
          href="/overstock"
          className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-800"
        >
          ← {detail.backLabel}
        </a>
      </div>
    );
  }

  const categoryLabel =
    list.categories.find((c) => c.key === product.category)?.label ?? product.category;
  const soldOut = stockStatus(product.inventory) === 'sold-out';
  const inCart = cart.has(product._id);

  const savings =
    product.unitPrice && product.clearancePrice
      ? Math.round((1 - product.clearancePrice / product.unitPrice) * 100)
      : 0;

  const specs = [
    { label: detail.codeLabel, value: product.productCode },
    { label: detail.categoryLabel, value: categoryLabel },
    { label: detail.moqLabel, value: product.moq !== undefined ? String(product.moq) : undefined },
    {
      label: detail.inventoryLabel,
      value: product.inventory !== undefined ? product.inventory.toLocaleString() : undefined,
    },
  ].filter((s) => s.value);

  function addToCart() {
    cart.add({
      id: product?._id ?? '',
      name: product?.name ?? '',
      image: product?.images?.[0],
      code: product?.productCode,
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <a
          href="/overstock"
          className="inline-flex items-center gap-2 text-sm font-medium text-ink-soft transition hover:text-brand-700"
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
          {detail.backLabel}
        </a>
      </div>

      <div className="mt-6 grid gap-10 lg:grid-cols-2">
        <Gallery images={product.images ?? []} alt={product.name} zoomHint={detail.zoomHint} />

        <div>
          <div className="flex items-center gap-3">
            <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
              {categoryLabel}
            </span>
            <StockBadge
              inventory={product.inventory}
              size="md"
              showCount
              labels={{
                available: detail.statusAvailable,
                low: detail.statusLow,
                soldOut: detail.statusSoldOut,
              }}
            />
          </div>

          <h1 className="mt-3 font-display text-3xl font-bold text-ink">{product.name}</h1>
          {product.description && (
            <p className="mt-3 text-base leading-relaxed text-ink-soft">{product.description}</p>
          )}

          {/* Clearance price focus */}
          <div className="mt-6 rounded-[var(--radius-card)] border border-accent-200 bg-accent-50 p-5">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-accent-700">
                  {detail.clearanceLabel}
                </p>
                <p className="font-display text-4xl font-bold text-accent-600">
                  {formatPrice(product.clearancePrice)}
                </p>
              </div>
              {product.unitPrice !== undefined && (
                <div className="pb-1">
                  <p className="text-sm text-ink-muted line-through">
                    {formatPrice(product.unitPrice)}
                  </p>
                  {savings > 0 && (
                    <p className="text-sm font-semibold text-green-600">
                      {detail.savingsLabel} {savings}%
                    </p>
                  )}
                </div>
              )}
            </div>
            {canSeeVip && product.vipPrice !== undefined && (
              <p className="mt-3 border-t border-accent-200 pt-3 text-sm font-semibold text-brand-700">
                {detail.vipLabel}: {formatPrice(product.vipPrice)}
              </p>
            )}
          </div>

          {/* Spec sheet */}
          <dl className="mt-6 divide-y divide-slate-100 rounded-[var(--radius-card)] border border-slate-200">
            {specs.map((spec) => (
              <div key={spec.label} className="flex items-center justify-between px-4 py-3">
                <dt className="text-sm text-ink-muted">{spec.label}</dt>
                <dd className="text-sm font-semibold text-ink">{spec.value}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-3">
              <dt className="text-sm text-ink-muted">{detail.unitPriceLabel}</dt>
              <dd className="text-sm font-semibold text-ink">{formatPrice(product.unitPrice)}</dd>
            </div>
          </dl>

          {soldOut && <p className="mt-4 text-sm text-ink-muted">{detail.soldOutNote}</p>}

          {/* Actions */}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => (inCart ? cart.remove(product._id) : addToCart())}
              className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-6 py-3.5 text-base font-semibold transition ${
                inCart
                  ? 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                  : 'bg-brand-700 text-white hover:bg-brand-800'
              }`}
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                {inCart ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
                )}
              </svg>
              {inCart ? detail.inInquiry : detail.addToInquiry}
            </button>

            {loggedIn ? (
              <button
                type="button"
                onClick={() => setShowInquiry(true)}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent-500 px-6 py-3.5 text-base font-semibold text-brand-950 transition hover:bg-accent-400"
              >
                {detail.inquiryCta}
              </button>
            ) : (
              <a
                href="/login"
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-6 py-3.5 text-base font-semibold text-ink-soft transition hover:border-brand-400 hover:text-brand-700"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
                {detail.vipLockedLabel}
              </a>
            )}
          </div>
        </div>
      </div>

      {showInquiry && (
        <InquiryForm
          items={[{ id: product._id, name: product.name }]}
          content={inquiry}
          onClose={() => setShowInquiry(false)}
        />
      )}

      <InquiryCartBar inquiry={inquiry} />
    </div>
  );
}
