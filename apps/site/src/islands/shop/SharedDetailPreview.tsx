import { type ReactNode, useEffect, useState } from 'react';
import { CatalogDetailController } from '../../catalog/application/CatalogDetailController.tsx';
import {
  CatalogLocalPreviewContext,
  CatalogQuoteTransportContext,
} from '../../catalog/application/catalog-quote-transport.ts';
import { submitLocalQuote } from '../../catalog/application/local-quote-transport.ts';
import { submitPublicQuote } from '../../catalog/application/public-quote-transport.ts';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { fetchProductBySlug } from './api.ts';
import type { Product } from './catalog-types.ts';
import { sharedVariantSearch } from './shared-detail-navigation.ts';
import { sharedPreviewTarget } from './shared-detail-preview-target.ts';

/** Ordinary ID/slug routes use approved details; pre-migration products retain their legacy page. */
export default function SharedDetailPreview({
  copy,
  legacy,
}: { copy: SharedDetailContent; legacy: (product?: Product) => ReactNode }) {
  const [search, setSearch] = useState<string>();
  const [resolved, setResolved] = useState<{ search: string; product?: Product; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const read = () => setSearch(window.location.search);
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    setResolved(undefined);
    const params = new URLSearchParams(search);
    if (search !== undefined && params.has('slug') && !params.has('id')) {
      void fetchProductBySlug(params.get('slug') ?? '', controller.signal)
        .then((product) => {
          if (!controller.signal.aborted) setResolved({ search, product });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setResolved({ search, error: error instanceof Error ? error.message : 'error' });
        });
    }
    return () => controller.abort();
  }, [search, attempt]);
  if (search === undefined)
    return <output className="block p-12 text-center">{copy.loadingLabel}</output>;
  const params = new URLSearchParams(search);
  const localPreview = import.meta.env.DEV && params.get('preview') === 'shared';
  if (params.has('slug') && params.has('id'))
    return (
      <p role="alert" className="p-12 text-center">
        {copy.errorLabel}
      </p>
    );
  if (!localPreview) {
    if (params.has('slug')) {
      if (resolved?.search !== search)
        return <output className="block p-12 text-center">{copy.loadingLabel}</output>;
      if (!resolved.product)
        return (
          <section role="alert" className="mx-auto max-w-2xl p-12 text-center">
            <h1>{resolved.error === 'not-found' ? copy.notFound : copy.errorLabel}</h1>
            <button
              type="button"
              className="mt-4 min-h-11 rounded border px-5"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {copy.retryLabel}
            </button>
          </section>
        );
      params.delete('slug');
      params.set('id', resolved.product._id);
    }
    if (params.has('id')) params.set('preview', 'shared');
  }
  const target = sharedPreviewTarget(true, `?${params}`);
  if (target.status === 'legacy') return legacy();
  if (target.status !== 'preview')
    return (
      <p role="alert" className="p-12 text-center">
        {copy.errorLabel}
      </p>
    );
  return (
    <CatalogLocalPreviewContext.Provider value={localPreview}>
      <CatalogQuoteTransportContext.Provider
        value={localPreview ? submitLocalQuote : submitPublicQuote}
      >
        <CatalogDetailController
          key={JSON.stringify([target.productId, target.requestedId])}
          productId={target.productId}
          requestedId={target.requestedId}
          copy={copy}
          legacyFallback={
            localPreview
              ? undefined
              : legacy(resolved?.search === search ? resolved.product : undefined)
          }
          onVariantChange={(variantId) => {
            const query = new URLSearchParams(window.location.search);
            if (!localPreview) {
              if (variantId) query.set('variant', variantId);
              else query.delete('variant');
            }
            const next = localPreview
              ? sharedVariantSearch(window.location.search, variantId)
              : `?${query}`;
            if (next !== undefined)
              window.history.replaceState(
                window.history.state,
                '',
                `${window.location.pathname}${next}`,
              );
          }}
        />
      </CatalogQuoteTransportContext.Provider>
    </CatalogLocalPreviewContext.Provider>
  );
}
