import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { fetchCatalogDetailPage } from '../infrastructure/catalog-detail-api.ts';
import { CatalogDetail } from '../presentation/CatalogDetail.tsx';
import { CatalogVariantGallery } from '../presentation/CatalogVariantGallery.tsx';
import {
  type ProductDetailEvent,
  type ProductDetailState,
  initialProductDetailState,
  reduceProductDetail,
} from './catalog-product-detail-state.ts';

export function CatalogDetailController({
  productId,
  requestedId,
  copy,
  backNavigation,
  focusOnOpen = false,
  onVariantChange,
  legacyFallback,
}: {
  productId: string;
  requestedId?: string;
  copy: SharedDetailContent;
  backNavigation?: ReactNode;
  focusOnOpen?: boolean;
  onVariantChange?: (id?: string) => void;
  legacyFallback?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const focusedProduct = useRef<string | undefined>(undefined);
  const [state, setState] = useState(initialProductDetailState);
  const current = useRef(state);
  const generation = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const requested = useRef(requestedId);
  requested.current = requestedId;
  const [retry, setRetry] = useState(0);
  const apply = useCallback((event: ProductDetailEvent) => {
    const next = reduceProductDetail(current.current, event);
    current.current = next;
    setState(next);
    return next;
  }, []);
  const perform = useCallback(
    async (initial: ProductDetailState) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      let pending = initial;
      while ((pending.status === 'loading' || pending.status === 'ready') && pending.request) {
        const result = await fetchCatalogDetailPage(pending.request, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const next = apply({
          type: 'result',
          generation: pending.generation,
          productId: pending.productId,
          result,
        });
        if (next.status !== 'ready' || next.pages.mode !== 'collecting' || next.pageError) return;
        pending = apply({
          type: 'page',
          generation: ++generation.current,
          page: next.pages.currentPage.variants.page + 1,
        });
      }
    },
    [apply],
  );
  useEffect(() => {
    void retry;
    void perform(
      apply({
        type: 'open',
        generation: ++generation.current,
        productId,
        requestedId: requested.current,
      }),
    );
    return () => {
      abort.current?.abort();
    };
  }, [productId, retry, apply, perform]);
  useEffect(() => {
    // URL selection is interaction state, not a new product/revision fetch.
    // Browser Back/Forward also uses this path, including an invalid deep link.
    apply({ type: 'restore-selection', productId, variantId: requestedId });
  }, [productId, requestedId, apply]);

  useEffect(() => {
    if (
      !focusOnOpen ||
      state.status !== 'ready' ||
      state.productId !== productId ||
      focusedProduct.current === productId
    )
      return;
    const heading = root.current?.querySelector<HTMLElement>('[data-shared-detail-heading]');
    if (!heading) return;
    focusedProduct.current = productId;
    // The route shell positions the viewport with its Back action visible.
    // Moving keyboard focus must not scroll that action behind the site header.
    heading.focus({ preventScroll: true });
  }, [focusOnOpen, productId, state]);

  if (state.status === 'idle' || state.status === 'loading' || state.productId !== productId)
    return <output className="block p-12 text-center">{copy.loadingLabel}</output>;
  if (state.status === 'error' && state.error.status === 'not-found' && legacyFallback)
    return legacyFallback;
  if (state.status === 'error')
    return (
      <section role="alert" className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="font-display text-2xl">
          {state.error.status === 'not-found'
            ? copy.notFound
            : state.error.status === 'refresh-required'
              ? copy.refreshLabel
              : copy.errorLabel}
        </h1>
        <button
          type="button"
          onClick={() => setRetry((n) => n + 1)}
          className="mt-6 min-h-11 rounded-lg border border-slate-300 px-5 font-semibold"
        >
          {copy.retryLabel}
        </button>
      </section>
    );
  const { pages, selection } = state;
  const detail = pages.currentPage;
  const select = (variantId?: string) => {
    const next = apply({ type: 'select', productId, revision: detail.revision, variantId });
    if (
      next.status === 'ready' &&
      (variantId === undefined ||
        (next.selection.status === 'selected' && next.selection.variant.id === variantId))
    )
      onVariantChange?.(variantId);
  };
  const page = (number: number) =>
    void perform(apply({ type: 'page', generation: ++generation.current, page: number }));
  const { page: number, pageSize, total } = detail.variants;
  return (
    <div ref={root}>
      <CatalogDetail
        pages={pages}
        selection={selection}
        copy={copy}
        backNavigation={backNavigation}
        onSelect={select}
        onClear={() => select()}
        media={
          <CatalogVariantGallery
            images={detail.images}
            name={detail.name}
            productId={productId}
            revision={detail.revision}
            unavailableLabel={copy.imageUnavailableLabel}
            selection={selection}
            variants={pages.items}
          />
        }
        pagination={
          <>
            {state.request && (
              <output className="block text-sm text-ink-muted">{copy.loadingLabel}</output>
            )}
            {state.pageError && (
              <div role="alert">
                <p>{copy.errorLabel}</p>
                <button
                  type="button"
                  className="min-h-11 text-brand-700 underline"
                  onClick={() => page(state.pageError?.page ?? number)}
                >
                  {copy.retryLabel}
                </button>
              </div>
            )}
            {pages.mode === 'paged' && (
              <nav
                aria-label={copy.pageLabel}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <button
                  type="button"
                  disabled={!!state.request || number <= 1}
                  onClick={() => page(number - 1)}
                  className="min-h-11 rounded-lg border px-3 disabled:opacity-40"
                >
                  {copy.previousLabel}
                </button>
                <span>
                  {copy.pageLabel} {number} / {Math.ceil(total / pageSize)}
                </span>
                <button
                  type="button"
                  disabled={!!state.request || number * pageSize >= total}
                  onClick={() => page(number + 1)}
                  className="min-h-11 rounded-lg border px-3 disabled:opacity-40"
                >
                  {copy.nextLabel}
                </button>
              </nav>
            )}
          </>
        }
      />
    </div>
  );
}
