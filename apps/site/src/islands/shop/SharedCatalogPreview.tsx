import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CatalogDetailController } from '../../catalog/application/CatalogDetailController.tsx';
import {
  CatalogLocalPreviewContext,
  CatalogQuoteTransportContext,
} from '../../catalog/application/catalog-quote-transport.ts';
import { submitLocalQuote } from '../../catalog/application/local-quote-transport.ts';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import {
  sharedDetailSearch,
  sharedListSearch,
  sharedListTarget,
  sharedVariantSearch,
} from './shared-detail-navigation.ts';

/** Dev-only navigation composition. The existing list owns filters and loaded pages.
 * Keep it mounted (but hidden) while detail is open; never cache product data in history/storage.
 */
export default function SharedCatalogPreview({
  copy,
  renderList,
}: {
  copy: SharedDetailContent;
  renderList: (open?: (productId: string) => void) => ReactNode;
}) {
  const [search, setSearch] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const returnPoint = useRef<
    { href: string; productId: string; x: number; y: number; token: string } | undefined
  >(undefined);
  const frame = useRef<number | undefined>(undefined);
  const restorePending = useRef(false);
  useEffect(() => {
    const read = () => {
      restorePending.current = sharedListTarget(true, window.location.search).status === 'list';
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
  }, []);

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
  }, [search]);

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
  }, [search]);

  const open = useCallback((productId: string) => {
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
  }, []);
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
        sharedListTarget(true, candidate).status === 'list' ? candidate : '?preview=shared';
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
            <CatalogLocalPreviewContext.Provider value={true}>
              <CatalogQuoteTransportContext.Provider value={submitLocalQuote}>
                <CatalogDetailController
                  key={JSON.stringify([target.productId, target.requestedId])}
                  productId={target.productId}
                  requestedId={target.requestedId}
                  copy={copy}
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
