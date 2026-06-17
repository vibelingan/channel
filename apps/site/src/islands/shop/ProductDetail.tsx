import { useEffect, useState } from 'react';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { Gallery } from './Gallery.tsx';
import { InquiryForm } from './InquiryForm.tsx';
import { PriceBlock } from './PriceBlock.tsx';
import { type Product, fetchProduct, formatPrice } from './api.ts';
import { useSession } from './session.ts';

interface Props {
  content: HeadphonesContent;
}

function getId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('id') ?? '';
}

/** Product detail island: gallery with zoom + spec sheet + price inquiry. */
export function ProductDetail({ content }: Props) {
  const { detail, list, inquiry } = content;
  const [product, setProduct] = useState<Product | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  const [showInquiry, setShowInquiry] = useState(false);
  const { canSeeVip, loggedIn } = useSession();

  useEffect(() => {
    const id = getId();
    if (!id) {
      setStatus('not-found');
      return;
    }
    fetchProduct(id)
      .then((p) => {
        setProduct(p);
        setStatus('ready');
      })
      .catch((e) =>
        setStatus(e instanceof Error && e.message === 'not-found' ? 'not-found' : 'error'),
      );
  }, []);

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
          href="/headphones"
          className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-800"
        >
          ← {detail.backLabel}
        </a>
      </div>
    );
  }

  const categoryLabel =
    list.categories.find((c) => c.key === product.category)?.label ?? product.category;

  const specs = [
    { label: detail.seriesLabel, value: product.series },
    { label: detail.modelLabel, value: product.modName },
    { label: detail.typeLabel, value: product.modType },
    { label: detail.moqLabel, value: product.moq !== undefined ? String(product.moq) : undefined },
  ].filter((s) => s.value);

  return (
    <div>
      <div className="flex items-center justify-between">
        <a
          href="/headphones"
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
          <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
            {categoryLabel}
          </span>
          <h1 className="mt-3 font-display text-3xl font-bold text-ink">{product.name}</h1>
          {product.description && (
            <p className="mt-3 text-base leading-relaxed text-ink-soft">{product.description}</p>
          )}

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

          {/* Pricing */}
          <div className="mt-6 rounded-[var(--radius-card)] bg-surface-alt p-5">
            <PriceBlock
              wholesaleLabel={detail.wholesaleLabel}
              vipLabel={detail.vipLabel}
              vipLockedLabel={detail.vipLockedLabel}
              wholesalePrice={product.wholesalePrice}
              vipPrice={product.vipPrice}
              registered={canSeeVip}
              size="lg"
            />
          </div>

          {/* Inquiry CTA — signed-in users only */}
          <div className="mt-6">
            {loggedIn ? (
              <button
                type="button"
                onClick={() => setShowInquiry(true)}
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
              </button>
            ) : (
              <a
                href="/login"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-6 py-3.5 text-base font-semibold text-ink-soft transition hover:border-brand-400 hover:text-brand-700 sm:w-auto"
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
                Sign in to request a quote
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
    </div>
  );
}
