import { type ReactNode, useEffect, useState } from 'react';
import type { CatalogContent } from '../../i18n/catalog.ts';
import { type Product, fetchCatalog } from './api.ts';

interface Props {
  content: CatalogContent;
}

const FEATURED_COUNT = 8;
const LOADING_PLACEHOLDERS = ['featured-1', 'featured-2', 'featured-3', 'featured-4'];

export function FeaturedProducts({ content }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry token intentionally starts a fresh request.
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    fetchCatalog('/api/products', { page: 1, pageSize: FEATURED_COUNT }, controller.signal)
      .then((page) => {
        setProducts(page.items);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  const linkedProducts = products.filter((product) => product.slug?.trim());
  const announcement =
    status === 'loading'
      ? content.list.loadingLabel
      : status === 'error'
        ? content.list.errorLabel
        : linkedProducts.length === 0
          ? content.hub.emptyLabel
          : `${linkedProducts.length} ${content.list.resultsLabel}`;

  let visualState: ReactNode;
  if (status === 'loading') {
    visualState = (
      <div
        aria-label={content.list.loadingLabel}
        aria-busy="true"
        className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-4"
      >
        {LOADING_PLACEHOLDERS.map((placeholder) => (
          <div key={placeholder} className="h-72 animate-pulse bg-slate-100" />
        ))}
      </div>
    );
  } else if (status === 'error') {
    visualState = (
      <div role="alert" className="border border-red-200 bg-red-50 px-5 py-6 text-sm text-red-800">
        <p>{content.list.errorLabel}</p>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="mt-4 min-h-11 border border-red-300 bg-white px-4 py-2 font-semibold hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
        >
          {content.list.retryLabel}
        </button>
      </div>
    );
  } else if (linkedProducts.length === 0) {
    visualState = (
      <p className="border-y border-slate-200 bg-white px-5 py-10 text-center text-ink-muted">
        {content.hub.emptyLabel}
      </p>
    );
  } else {
    visualState = (
      <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
        {linkedProducts.map((product) => (
          <a
            key={product._id}
            href={`/products/item/?slug=${encodeURIComponent(product.slug ?? '')}`}
            className="group min-w-0 bg-white p-4 transition hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-brand-700"
          >
            <div className="aspect-square overflow-hidden bg-slate-100">
              {product.images?.[0] ? (
                <img
                  src={product.images[0]}
                  alt={product.name}
                  loading="lazy"
                  className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]"
                />
              ) : (
                <div className="grid h-full place-items-center px-4 text-center text-sm text-ink-muted">
                  {product.name}
                </div>
              )}
            </div>
            {product.skuCode && (
              <p className="mt-4 text-xs font-semibold uppercase text-brand-600">
                {product.skuCode}
              </p>
            )}
            <h3 className="mt-1 line-clamp-2 font-display text-base font-semibold text-ink group-hover:text-brand-700">
              {product.name}
            </h3>
            {product.moq !== undefined && (
              <p className="mt-2 text-sm text-ink-muted">
                {content.list.moqLabel} {product.moq}
              </p>
            )}
          </a>
        ))}
      </div>
    );
  }

  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {visualState}
    </>
  );
}
