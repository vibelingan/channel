import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CatalogDetailController } from '../../catalog/application/CatalogDetailController.tsx';
import {
  CatalogLocalPreviewContext,
  CatalogQuoteTransportContext,
} from '../../catalog/application/catalog-quote-transport.ts';
import { submitLocalQuote } from '../../catalog/application/local-quote-transport.ts';
import { submitPublicQuote } from '../../catalog/application/public-quote-transport.ts';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import {
  sharedDetailSearch as previewDetailSearch,
  sharedListSearch as previewListSearch,
  sharedListTarget as previewListTarget,
  sharedVariantSearch as previewVariantSearch,
} from './shared-detail-navigation.ts';

/** Ordinary and local-preview navigation. The existing list owns filters and loaded pages.
 * Keep it mounted (but hidden) while detail is open; never cache product data in history/storage.
 */
export default function SharedCatalogPreview({
  copy,
  renderList,
  renderLegacyDetail,
}: {
  copy: SharedDetailContent;
  renderList: (open?: (productId: string) => void) => ReactNode;
  renderLegacyDetail?: (productId: string) => ReactNode;
}) {
  const localPreview =
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('preview') === 'shared';
  const { sharedListTarget, sharedDetailSearch, sharedListSearch, sharedVariantSearch } =
    useMemo(() => {
      const normalize = (search: string) => {
        const params = new URLSearchParams(search);
        if (!localPreview) params.set('preview', 'shared');
        return `?${params}`;
      };
      const external = (search: string | undefined) => {
        if (search === undefined || localPreview) return search;
        const params = new URLSearchParams(search);
        params.delete('preview');
        return params.size ? `?${params}` : '';
      };
      const sharedListTarget = (_development: boolean, search: string) =>
        previewListTarget(true, normalize(search));
      const sharedDetailSearch = (search: string, id: string) =>
        external(previewDetailSearch(normalize(search), id));
      const sharedListSearch = (search: string) =>
        external(previewListSearch(normalize(search))) ?? '';
      const sharedVariantSearch = (search: string, id?: string) =>
        external(previewVariantSearch(normalize(search), id));
      return { sharedListTarget, sharedDetailSearch, sharedListSearch, sharedVariantSearch };
    }, [localPreview]);
  const [search, setSearch] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const returnPoint = useRef<
    { href: string; productId: string; x: number; y: number; token: string } | undefined
  >(undefined);
  const frame = useRef<number | undefined>(undefined);
  const restorePending = useRef(false);
  useEffect(() => {
    const read = (event?: PopStateEvent) => {
      // Initial hydration is not Back navigation. Restoring here used to yank
      // the visitor past the hero while the first catalog request was loading.
      restorePending.current =
        Boolean(event) && sharedListTarget(true, window.location.search).status === 'list';
      setSearch(window.location.search);
    };
    read();
    const previous = window.history.scrollRestoration;
    // Browser automatic restoration competes with the mounted list's exact scroll restoration.
    if (sharedListTarget(true, window.location.search).status !== 'legacy')
      window.history.scrollRestoration = 'manual';
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('popstate', read);
      window.history.scrollRestoration = previous;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [sharedListTarget]);

  useEffect(() => {
    if (
      search === undefined ||
      !restorePending.current ||
      sharedListTarget(true, search).status !== 'list'
    )
      return;
    restorePending.current = false;
    const point = returnPoint.current;
    frame.current = requestAnimationFrame(() => {
      if (sharedListTarget(true, window.location.search).status !== 'list') return;
      const card =
        point && point.href === window.location.href
          ? list.current?.querySelector<HTMLElement>(
              `[data-product-card="${CSS.escape(point.productId)}"]`,
            )
          : undefined;
      if (card && point) {
        card.focus({ preventScroll: true });
        window.scrollTo({ left: point.x, top: point.y, behavior: 'instant' });
      } else {
        list.current?.focus({ preventScroll: true });
        list.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    });
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [search, sharedListTarget]);

  useEffect(() => {
    if (
      search === undefined ||
      !['preview', 'invalid'].includes(sharedListTarget(true, search).status)
    )
      return;
    const target = navigation.current?.querySelector<HTMLElement>(
      '[data-shared-detail-heading], button',
    );
    target?.focus({ preventScroll: true });
    navigation.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [search, sharedListTarget]);

  const open = useCallback(
    (productId: string) => {
      const next = sharedDetailSearch(window.location.search, productId);
      if (next === undefined) return;
      const token = crypto.randomUUID();
      returnPoint.current = {
        href: window.location.href,
        productId,
        x: window.scrollX,
        y: window.scrollY,
        token,
      };
      window.history.pushState(
        { channelSharedNavigation: token },
        '',
        `${window.location.pathname}${next}`,
      );
      setSearch(next);
    },
    [sharedDetailSearch],
  );
  const back = () => {
    if (
      returnPoint.current &&
      window.history.state?.channelSharedNavigation === returnPoint.current.token
    ) {
      window.history.back();
    } else {
      // A fresh deep link has no owned preceding entry; never send the user to an external referrer.
      const candidate = sharedListSearch(window.location.search);
      const next =
        sharedListTarget(true, candidate).status === 'list'
          ? candidate
          : localPreview
            ? '?preview=shared'
            : '';
      window.history.replaceState(null, '', `${window.location.pathname}${next}`);
      restorePending.current = true;
      setSearch(next);
    }
  };
  const variantChanged = (variantId?: string) => {
    const next = sharedVariantSearch(window.location.search, variantId);
    if (next !== undefined)
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}`);
    // No React route reset: URL mirrors a validated selection; controller still owns the draft.
  };
  if (search === undefined)
    return <output className="block p-12 text-center">{copy.loadingLabel}</output>;
  const target = sharedListTarget(true, search);
  if (target.status === 'legacy') return renderList();
  const detailOpen = target.status !== 'list';
  return (
    <>
      <div ref={list} hidden={detailOpen} tabIndex={-1} data-shared-catalog-list>
        {renderList(open)}
      </div>
      {detailOpen && (
        <section ref={navigation} data-shared-detail-navigation>
          <button
            type="button"
            onClick={back}
            className="my-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-brand-700 focus-visible:outline-brand-700"
          >
            <span aria-hidden="true">←</span>
            {copy.backLabel}
          </button>
          {target.status !== 'preview' ? (
            <p role="alert">{copy.errorLabel}</p>
          ) : (
            <CatalogLocalPreviewContext.Provider value={localPreview}>
              <CatalogQuoteTransportContext.Provider
                value={localPreview ? submitLocalQuote : submitPublicQuote}
              >
                <CatalogDetailController
                  key={JSON.stringify([target.productId, target.requestedId])}
                  productId={target.productId}
                  requestedId={target.requestedId}
                  copy={copy}
                  legacyFallback={localPreview ? undefined : renderLegacyDetail?.(target.productId)}
                  backNavigation={null}
                  focusOnOpen
                  onVariantChange={variantChanged}
                />
              </CatalogQuoteTransportContext.Provider>
            </CatalogLocalPreviewContext.Provider>
          )}
        </section>
      )}
    </>
  );
}
