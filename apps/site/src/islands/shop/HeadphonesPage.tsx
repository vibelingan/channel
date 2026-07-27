import { useEffect, useMemo, useRef, useState } from 'react';
import { Gallery } from './Gallery.tsx';
import { InquiryForm } from './InquiryForm.tsx';
import { PriceBlock } from './PriceBlock.tsx';
import {
  type CatalogPage,
  type Product,
  fetchCatalog,
  formatPrice,
} from './api.ts';
import { useSession } from './session.ts';
import type { HeadphonesContent } from '../../i18n/headphones.ts';

/** Strings the standalone headphones page needs beyond what HeadphonesContent provides. */
interface PageStrings {
  /** Hero banner */
  heroEyebrow: string;
  heroHeading: string;
  heroBody: string;
  heroBadges: string[];
  /** Product matrix */
  matrixEyebrow: string;
  matrixHeading: string;
  matrixSubheading: string;
  /** Product cards */
  viewDetail: string;
  moqLabel: string;
  unitPriceLabel: string;
  /** Detail section */
  detailHeading: string;
  backToMatrix: string;
  /** Advantages */
  advEyebrow: string;
  advHeading: string;
  advItems: { title: string; desc: string; icon: string }[];
  /** Inquiry CTA */
  ctaEyebrow: string;
  ctaHeading: string;
  ctaBody: string;
  ctaButton: string;
}

interface Props {
  content: HeadphonesContent;
  strings: PageStrings;
}

/** The main interactive island for the standalone Headphones product page. */
export function HeadphonesPage({ content, strings }: Props) {
  const { list, inquiry } = content;
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [showInquiry, setShowInquiry] = useState(false);
  const [inquiryProduct, setInquiryProduct] = useState<Product | null>(null);
  const detailRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const { canSeeVip, loggedIn } = useSession();

  // Fetch all published headphones products (no category filter — show everything).
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    fetchCatalog('/api/products', { pageSize: 48 })
      .then((result: CatalogPage) => {
        if (!active) return;
        setProducts(result.items);
      })
      .catch((e: unknown) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Failed to load products',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // Group products by category for the matrix display.
  const categoryGroups = useMemo(() => {
    const groups = new Map<string, Product[]>();
    for (const p of products) {
      const cat = p.category || 'uncategorized';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    return groups;
  }, [products]);

  const categoryLabel = (key: string) =>
    list.categories.find((c) => c.key === key)?.label ?? key;

  function scrollToDetail(productId: string) {
    setActiveProductId(productId);
    // Defer scroll to after React re-render mounts the detail section.
    requestAnimationFrame(() => {
      const el = detailRefs.current.get(productId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  function openInquiry(product: Product) {
    setInquiryProduct(product);
    setShowInquiry(true);
  }

  const activeProduct = activeProductId
    ? products.find((p) => p._id === activeProductId) ?? null
    : null;

  return (
    <>
      {/* ========== Product Matrix ========== */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.15em] text-brand-600">
              {strings.matrixEyebrow}
            </p>
            <h2 className="mt-4 font-display text-3xl font-bold text-ink sm:text-4xl">
              {strings.matrixHeading}
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-soft">
              {strings.matrixSubheading}
            </p>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((key) => (
                <div
                  key={key}
                  className="h-80 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-100"
                />
              ))}
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div className="mt-12 rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && products.length === 0 && (
            <div className="mt-12 rounded-lg border border-slate-200 bg-surface-alt p-12 text-center text-ink-muted">
              {list.emptyLabel}
            </div>
          )}

          {/* Product cards grouped by category */}
          {!loading &&
            !error &&
            products.length > 0 &&
            [...categoryGroups.entries()].map(([catKey, catProducts]) => (
              <div key={catKey} className="reveal mt-12 first:mt-12">
                <div className="mb-6 flex items-center gap-3">
                  <h3 className="font-display text-xl font-semibold text-ink">
                    {categoryLabel(catKey)}
                  </h3>
                  <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                    {catProducts.length}{' '}
                    {catProducts.length === 1 ? 'model' : 'models'}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {catProducts.map((product) => (
                    <button
                      key={product._id}
                      type="button"
                      onClick={() => scrollToDetail(product._id)}
                      className="group relative flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-[var(--shadow-card)]"
                    >
                      {/* Product image — white background */}
                      <div className="relative aspect-square overflow-hidden bg-white">
                        <img
                          src={
                            product.images?.[0] ??
                            '/api/images/_placeholder'
                          }
                          alt={product.name}
                          loading="lazy"
                          className="h-full w-full object-contain p-6 transition duration-300 group-hover:scale-105"
                        />
                      </div>

                      {/* Card info */}
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
                            {product.moq !== undefined && (
                              <span>
                                {strings.moqLabel}:{' '}
                                <strong>{product.moq}</strong>
                              </span>
                            )}
                            {product.unitPrice !== undefined && (
                              <span className="font-display text-sm font-bold text-brand-700">
                                {formatPrice(product.unitPrice)}
                              </span>
                            )}
                          </div>
                          <div className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-brand-600 transition group-hover:text-brand-700">
                            {strings.viewDetail}
                            <svg
                              className="h-3.5 w-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              aria-hidden="true"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M9 5l7 7-7 7"
                              />
                            </svg>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </section>

      {/* ========== Product Detail Sections (expanded below matrix) ========== */}
      {activeProduct && (
        <section className="border-t border-slate-200 bg-surface-alt py-16 sm:py-20">
          <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
            <div
              ref={(el) => {
                if (el) detailRefs.current.set(activeProduct._id, el);
              }}
            >
              {/* Back to matrix */}
              <button
                type="button"
                onClick={() => setActiveProductId(null)}
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
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
                {strings.backToMatrix}
              </button>

              <div className="grid gap-10 lg:grid-cols-2">
                {/* Left: Gallery */}
                <Gallery
                  images={activeProduct.images ?? []}
                  alt={activeProduct.name}
                  zoomHint={content.detail.zoomHint}
                />

                {/* Right: Specs + Inquiry */}
                <div>
                  <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                    {categoryLabel(activeProduct.category)}
                  </span>
                  <h2 className="mt-3 font-display text-3xl font-bold text-ink">
                    {activeProduct.name}
                  </h2>
                  {activeProduct.modName && (
                    <p className="mt-1 text-sm font-medium uppercase tracking-wide text-ink-muted">
                      {activeProduct.modName}
                    </p>
                  )}
                  {activeProduct.description && (
                    <p className="mt-4 text-base leading-relaxed text-ink-soft">
                      {activeProduct.description}
                    </p>
                  )}

                  {/* Spec sheet */}
                  <dl className="mt-6 divide-y divide-slate-100 rounded-[var(--radius-card)] border border-slate-200 bg-white">
                    {activeProduct.series && (
                      <div className="flex items-center justify-between px-4 py-3">
                        <dt className="text-sm text-ink-muted">
                          {content.detail.seriesLabel}
                        </dt>
                        <dd className="text-sm font-semibold text-ink">
                          {activeProduct.series}
                        </dd>
                      </div>
                    )}
                    {activeProduct.modType && (
                      <div className="flex items-center justify-between px-4 py-3">
                        <dt className="text-sm text-ink-muted">
                          {content.detail.typeLabel}
                        </dt>
                        <dd className="text-sm font-semibold text-ink">
                          {activeProduct.modType}
                        </dd>
                      </div>
                    )}
                    {activeProduct.moq !== undefined && (
                      <div className="flex items-center justify-between px-4 py-3">
                        <dt className="text-sm text-ink-muted">
                          {content.detail.moqLabel}
                        </dt>
                        <dd className="text-sm font-semibold text-ink">
                          {activeProduct.moq}
                        </dd>
                      </div>
                    )}
                    {activeProduct.unitPrice !== undefined && (
                      <div className="flex items-center justify-between px-4 py-3">
                        <dt className="text-sm text-ink-muted">
                          {content.detail.unitPriceLabel}
                        </dt>
                        <dd className="font-display text-base font-bold text-brand-700">
                          {formatPrice(activeProduct.unitPrice)}
                        </dd>
                      </div>
                    )}
                    {activeProduct.productCode && (
                      <div className="flex items-center justify-between px-4 py-3">
                        <dt className="text-sm text-ink-muted">
                          Product Code
                        </dt>
                        <dd className="text-sm font-medium text-ink">
                          {activeProduct.productCode}
                        </dd>
                      </div>
                    )}
                  </dl>

                  {/* Pricing block */}
                  <div className="mt-6 rounded-[var(--radius-card)] bg-white p-5 shadow-sm ring-1 ring-slate-200">
                    <PriceBlock
                      wholesaleLabel={content.detail.wholesaleLabel}
                      vipLabel={content.detail.vipLabel}
                      vipLockedLabel={content.detail.vipLockedLabel}
                      wholesalePrice={activeProduct.wholesalePrice}
                      vipPrice={activeProduct.vipPrice}
                      registered={canSeeVip}
                      size="lg"
                    />
                  </div>

                  {/* Inquiry CTA */}
                  <div className="mt-6">
                    {loggedIn ? (
                      <button
                        type="button"
                        onClick={() => openInquiry(activeProduct)}
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
                        {content.detail.inquiryCta}
                      </button>
                    ) : (
                      <a
                        href="#headphones-inquiry"
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
                        Send Enquiry
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ========== Factory Advantages ========== */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.15em] text-brand-600">
              {strings.advEyebrow}
            </p>
            <h2 className="mt-4 font-display text-3xl font-bold text-ink sm:text-4xl">
              {strings.advHeading}
            </h2>
          </div>
          <div className="reveal mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {strings.advItems.map((item, i) => (
              <div
                key={i}
                className="rounded-[var(--radius-card)] border border-slate-200 bg-surface-alt p-6 text-center shadow-sm transition hover:-translate-y-1 hover:shadow-[var(--shadow-card)]"
              >
                <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-brand-50 text-2xl text-brand-600">
                  {item.icon}
                </span>
                <h3 className="mt-4 font-display text-base font-semibold text-ink">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ========== Bottom Inquiry CTA ========== */}
      <section
        id="headphones-inquiry"
        className="relative scroll-mt-[var(--spacing-header)] overflow-hidden bg-surface-dark text-white"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-10"
          aria-hidden="true"
        >
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(rgba(99,102,241,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.5) 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            }}
          />
        </div>
        <div className="relative mx-auto max-w-[var(--width-container)] px-4 py-16 text-center sm:px-6 sm:py-24 lg:px-8">
          <div className="reveal mx-auto max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.15em] text-accent-300">
              {strings.ctaEyebrow}
            </p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-4xl">
              {strings.ctaHeading}
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-slate-300">
              {strings.ctaBody}
            </p>
            <div className="mt-8">
              {loggedIn ? (
                <button
                  type="button"
                  onClick={() => {
                    setInquiryProduct(null);
                    setShowInquiry(true);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-accent-500 px-8 py-4 text-base font-semibold text-brand-950 shadow-lg transition hover:bg-accent-400"
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
                  {strings.ctaButton}
                </button>
              ) : (
                <a
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-lg bg-accent-500 px-8 py-4 text-base font-semibold text-brand-950 shadow-lg transition hover:bg-accent-400"
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
                  {strings.ctaButton}
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ========== Inquiry Modal ========== */}
      {showInquiry && (
        <InquiryForm
          items={
            inquiryProduct
              ? [{ id: inquiryProduct._id, name: inquiryProduct.name }]
              : products.map((p) => ({ id: p._id, name: p.name }))
          }
          content={inquiry}
          onClose={() => setShowInquiry(false)}
        />
      )}
    </>
  );
}
