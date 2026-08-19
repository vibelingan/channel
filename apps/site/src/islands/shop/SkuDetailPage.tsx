import { useEffect, useState } from 'react';
import type { CatalogContent } from '../../i18n/catalog.ts';
import {
  catalogBreadcrumbSchema,
  catalogProductSchema,
  serializeCatalogSchema,
  skuBreadcrumbs,
} from '../../lib/catalog-seo.ts';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';
import { AlibabaCatalogPricingBlock } from './AlibabaCatalogPricingBlock.tsx';
import { catalogProductPrice, hasUsableCatalogSlug } from './CatalogFamilyGrid.tsx';
import { Gallery } from './Gallery.tsx';
import { ProductMedia } from './ProductMedia.tsx';
import { fetchProductBySlug, fetchRelatedProducts } from './api.ts';
import { isPublicationCompleteCatalogProduct } from './catalog-pricing.ts';
import type { Product } from './catalog-types.ts';

export type SkuDetailViewState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; product: Product; related: Product[] };

interface ViewProps {
  content: CatalogContent;
  state: SkuDetailViewState;
  onRetry: () => void;
}

interface Props {
  content: CatalogContent;
}

function productFacts(product: Product): Array<{ label: string; value: string }> {
  return [
    product.skuCode ? { label: 'SKU', value: product.skuCode } : null,
    product.series ? { label: 'Series', value: product.series } : null,
    product.modName ? { label: 'Model', value: product.modName } : null,
    product.modType ? { label: 'Type', value: product.modType } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
}

function relatedProducts(product: Product, related: Product[]): Array<Product & { slug: string }> {
  if (!product.productFamily) return [];
  return related.filter(
    (candidate): candidate is Product & { slug: string } =>
      candidate._id !== product._id &&
      candidate.productFamily === product.productFamily &&
      hasUsableCatalogSlug(candidate),
  );
}

export function SkuDetailView({ content, state, onRetry }: ViewProps) {
  const { detail, list } = content;
  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-[var(--width-container)] px-4 py-20 sm:px-6 lg:px-8">
        <h1 className="sr-only">Product details</h1>
        <p className="text-center text-ink-muted" aria-live="polite">
          {list.loadingLabel}
        </p>
      </div>
    );
  }

  if (state.status === 'not-found') {
    return (
      <div className="mx-auto max-w-[var(--width-container)] px-4 py-20 text-center sm:px-6 lg:px-8">
        <h1 className="font-display text-3xl font-bold text-ink">{detail.notFound}</h1>
        <a
          href="/electronics-toys/"
          className="mt-6 inline-flex min-h-11 items-center font-semibold text-brand-700 underline"
        >
          {detail.backLabel}
        </a>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        role="alert"
        className="mx-auto my-20 max-w-2xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800"
      >
        <h1 className="font-display text-2xl font-bold text-red-900">
          Product details unavailable
        </h1>
        <p>{list.errorLabel}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 min-h-11 border border-red-300 bg-white px-4 py-2 font-semibold"
        >
          {list.retryLabel}
        </button>
      </div>
    );
  }

  const { product } = state;
  const facts = productFacts(product);
  const related = relatedProducts(product, state.related);
  const alibabaLinked = Boolean(product.alibabaPrimarySourceKey);
  const moq = alibabaLinked ? product.alibabaCatalogPricing?.sourceMoq : product.moq;
  const breadcrumbs = skuBreadcrumbs(product);
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  // The public slug endpoint admits only published, non-archived products.
  const productSchema = catalogProductSchema(product, origin, { published: true });
  const schemaNodes = [
    ...(breadcrumbs.length > 0 ? [catalogBreadcrumbSchema(breadcrumbs, origin)] : []),
    ...(productSchema ? [productSchema] : []),
  ];

  return (
    <>
      <section data-sku-detail={product._id} className="bg-white py-12 sm:py-16">
        <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
          <nav aria-label="Breadcrumb" className="mb-8 text-sm text-ink-muted">
            {breadcrumbs.map((breadcrumb, index) =>
              index < breadcrumbs.length - 1 ? (
                <span key={breadcrumb.href}>
                  <a href={breadcrumb.href} className="hover:text-brand-700">
                    {breadcrumb.label}
                  </a>
                  <span className="px-2" aria-hidden="true">
                    /
                  </span>
                </span>
              ) : (
                <span key={breadcrumb.href} aria-current="page">
                  {breadcrumb.label}
                </span>
              ),
            )}
          </nav>
          <div className="grid min-w-0 gap-10 lg:grid-cols-2">
            <div className="min-w-0">
              <Gallery
                images={product.images ?? []}
                alt={product.name}
                productId={product._id}
                unavailableLabel="Product image unavailable"
              />
            </div>
            <div className="min-w-0">
              <h1 className="break-words font-display text-4xl font-bold text-ink">
                {product.name}
              </h1>
              {product.description && (
                <p className="mt-5 break-words text-lg leading-relaxed text-ink-soft">
                  {product.description}
                </p>
              )}

              {(facts.length > 0 || moq !== undefined) && (
                <dl className="mt-8 divide-y divide-slate-100 border border-slate-200 bg-white">
                  {facts.map((fact) => (
                    <div
                      key={fact.label}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <dt className="text-sm text-ink-muted">{fact.label}</dt>
                      <dd className="min-w-0 break-words text-right text-sm font-semibold text-ink">
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                  {moq !== undefined && (
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <dt className="text-sm text-ink-muted">{list.moqLabel}</dt>
                      <dd className="text-sm font-semibold text-ink">{moq}</dd>
                    </div>
                  )}
                </dl>
              )}

              <div className="mt-8 border-y border-slate-200 py-5">
                {alibabaLinked ? (
                  <AlibabaCatalogPricingBlock pricing={product.alibabaCatalogPricing} size="lg" />
                ) : (
                  <p className="font-display text-2xl font-bold text-brand-700">
                    {catalogProductPrice(product, detail.inquiryCta)}
                  </p>
                )}
              </div>
              <div className="mt-8 border-l-4 border-brand-600 bg-surface-alt px-5 py-5">
                <p className="text-xs font-semibold uppercase text-brand-600">
                  {detail.oemEyebrow}
                </p>
                <h2 className="mt-2 font-display text-xl font-bold text-ink">
                  {detail.oemHeading}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{detail.oemBody}</p>
                <a
                  href={OEM_INQUIRY_HREF}
                  className="mt-5 inline-flex min-h-11 items-center justify-center bg-accent-500 px-6 py-3 font-semibold text-brand-950 hover:bg-accent-400"
                >
                  {detail.inquiryCta}
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {related.length > 0 && (
        <section
          className="border-t border-slate-200 bg-surface-alt py-12"
          aria-labelledby="related-products-heading"
        >
          <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
            <h2 id="related-products-heading" className="font-display text-2xl font-bold text-ink">
              {detail.relatedHeading}
            </h2>
            <div className="mt-6 grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((candidate) => (
                <a
                  key={candidate._id}
                  href={`/products/item/?slug=${encodeURIComponent(candidate.slug.trim())}`}
                  className="group min-w-0 bg-white p-4 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-brand-700"
                >
                  <div className="aspect-square overflow-hidden bg-white">
                    <ProductMedia
                      sources={candidate.images ?? []}
                      alt={candidate.name}
                      imageClassName="p-4"
                    />
                  </div>
                  <h3 className="mt-3 font-display text-base font-semibold text-ink group-hover:text-brand-700">
                    {candidate.name}
                  </h3>
                </a>
              ))}
            </div>
          </div>
        </section>
      )}
      {schemaNodes.length > 0 && (
        <script
          type="application/ld+json"
          data-catalog-schema
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serializer escapes `<` so remote text cannot terminate the script.
          dangerouslySetInnerHTML={{ __html: serializeCatalogSchema(schemaNodes) }}
        />
      )}
    </>
  );
}

export function SkuDetailPage({ content }: Props) {
  const [state, setState] = useState<SkuDetailViewState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry token intentionally starts a fresh request.
  useEffect(() => {
    const controller = new AbortController();
    const slug = new URLSearchParams(window.location.search).get('slug')?.trim() ?? '';
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = new URL('/products/item/', window.location.origin).href;
    if (!slug) {
      setState({ status: 'not-found' });
      return () => controller.abort();
    }
    setState({ status: 'loading' });
    fetchProductBySlug(slug, controller.signal)
      .then((product) => {
        if (controller.signal.aborted) return;
        if (canonical && isPublicationCompleteCatalogProduct(product)) {
          canonical.href = new URL(
            `/products/item/?slug=${encodeURIComponent(product.slug?.trim() ?? '')}`,
            window.location.origin,
          ).href;
        }
        setState({ status: 'ready', product, related: [] });
        fetchRelatedProducts(product, 4, controller.signal)
          .then((related) => {
            if (controller.signal.aborted) return;
            setState((current) =>
              current.status === 'ready' && current.product._id === product._id
                ? { ...current, related }
                : current,
            );
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            console.error('[sku-detail] related products failed', error);
          });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: error instanceof Error && error.message === 'not-found' ? 'not-found' : 'error',
        });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <SkuDetailView
      content={content}
      state={state}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
