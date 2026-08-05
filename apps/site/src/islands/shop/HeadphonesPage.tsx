/**
 * Headphones page controller (MIU 13).
 *
 * A thin controller: it owns fetching, request generations, abortion, and the
 * focus lifecycle, and delegates ALL presentation to HeadphonesCatalog and
 * HeadphonesProductDetail. It declares no copy of its own — every string comes
 * from the typed `HeadphonesContent` contract — and no state shape of its own:
 * that lives in `headphonesCatalogState.ts`.
 *
 * Pagination is user-triggered, 12 items per page, and modeled as eventual
 * consistency (never a fetch-all/snapshot claim). Every in-flight request is
 * tagged with the generation it started under and backed by an AbortController,
 * so an auth identity change resets to page 1 and orphans anything in flight.
 *
 * Gallery media is interaction-gated: the detail band (and therefore Gallery)
 * only mounts once a card is expanded, so a catalog page never turns its
 * gallery references into initial image requests.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';
import { HeadphonesCatalog } from './HeadphonesCatalog.tsx';
import { HeadphonesProductDetail } from './HeadphonesProductDetail.tsx';
import { fetchCatalog } from './api.ts';
import {
  type HeadphonesCatalogState,
  beginInitialLoad,
  beginLoadMore,
  commitCatalogPage,
  failInitialLoad,
  failLoadMore,
  initialHeadphonesCatalogState,
  resetCatalogGeneration,
  setActiveProduct,
} from './headphonesCatalogState.ts';
import { useSession } from './session.ts';

interface Props {
  content: HeadphonesContent;
}

const CATALOG_PATH = '/api/products';
const PAGE_SIZE = 12;

export function detailScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}

export function HeadphonesPage({ content }: Props) {
  const { list, detail, oemCta } = content;
  const [state, setState] = useState<HeadphonesCatalogState>(initialHeadphonesCatalogState);
  const { canSeeVip, user, loggedIn, ready } = useSession();

  // A render-synchronised mirror of `state`. Transitions that need to know the
  // generation they just produced MUST compute it here rather than inside a
  // setState updater: updaters run asynchronously, so reading the generation
  // out of one would hand the fetch a stale value and every commit would be
  // rejected by the reducer's own generation guard.
  const stateRef = useRef(state);
  stateRef.current = state;

  // The card that opened the current detail band; focus returns here on Back.
  const originCardIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Incremented on every card activation so the focus effect fires even when
  // the same product is re-activated.
  const [openToken, setOpenToken] = useState(0);

  /**
   * Load one page under `generation`. The caller has already moved the state
   * into a loading status; a response whose generation is stale no-ops inside
   * the reducer, so an aborted or superseded request can never commit.
   */
  const loadPage = useCallback(
    (generation: number, page: number, initial: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      fetchCatalog(CATALOG_PATH, { page, pageSize: PAGE_SIZE }, controller.signal)
        .then((result) => setState((current) => commitCatalogPage(current, generation, result)))
        .catch((error: unknown) => {
          // An abort is an intentional supersede, never a user-facing error.
          if (controller.signal.aborted) return;
          // Show AUTHORED copy. `error.message` is transport/server text
          // ("Failed to load catalog (500)", "Load failed") that is neither
          // localized nor in the content contract; keep it for diagnostics.
          console.error('[headphones] catalog page failed', error);
          setState((current) =>
            initial
              ? failInitialLoad(current, generation, list.errorLabel)
              : failLoadMore(current, generation, list.errorLabel),
          );
        });
    },
    [list.errorLabel],
  );

  // Identity of the signed-in user. A change (sign in, sign out, switch
  // account) invalidates every loaded page because pricing is role-gated.
  const identity = ready ? `${loggedIn ? '1' : '0'}:${user?.id ?? ''}:${user?.role ?? ''}` : null;

  /** Apply a computed transition and keep the mirror in step. */
  const commit = useCallback((next: HeadphonesCatalogState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (identity === null) return;
    // A cross-tab sign-in/out wipes the catalog, which unmounts any open
    // detail band. If focus was inside it, rescue focus to the catalog
    // heading instead of letting it fall to <body>.
    const focusWasInsideDetail =
      typeof document !== 'undefined' &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('[data-product-detail]') !== null;
    originCardIdRef.current = null;
    const loading = beginInitialLoad(resetCatalogGeneration(stateRef.current));
    commit(loading);
    if (focusWasInsideDetail) {
      document.querySelector<HTMLElement>('[data-catalog-heading]')?.focus();
    }
    loadPage(loading.generation, 1, true);
    return () => abortRef.current?.abort();
  }, [identity, loadPage, commit]);

  const handleRetryInitial = useCallback(() => {
    const current = stateRef.current;
    // Symmetric with handleLoadMore: never start a second initial load on top
    // of one already in flight. (beginInitialLoad has no status precondition.)
    if (current.status === 'loading-initial' || current.status === 'loading-more') return;
    const loading = beginInitialLoad(current);
    commit(loading);
    loadPage(loading.generation, 1, true);
  }, [loadPage, commit]);

  const handleLoadMore = useCallback(() => {
    const current = stateRef.current;
    const loading = beginLoadMore(current);
    // beginLoadMore is a no-op unless the catalog is ready; only issue a
    // request when it actually transitioned.
    if (loading === current) return;
    commit(loading);
    loadPage(loading.generation, loading.nextPage, false);
  }, [loadPage, commit]);

  const handleOpenProduct = useCallback(
    (productId: string) => {
      originCardIdRef.current = productId;
      // Bump a token rather than relying on `activeProduct` changing:
      // re-activating the ALREADY-open card resolves to the same product
      // object, so an effect keyed on it alone would never re-run and the
      // second activation would be a dead interaction.
      setOpenToken((token) => token + 1);
      commit(setActiveProduct(stateRef.current, productId));
    },
    [commit],
  );

  const handleBack = useCallback(() => {
    const originId = originCardIdRef.current;
    commit(setActiveProduct(stateRef.current, null));
    // Restore focus to the card that opened the detail band.
    requestAnimationFrame(() => {
      if (!originId) return;
      const selector = `[data-product-card="${CSS.escape(originId)}"]`;
      const card = document.querySelector<HTMLElement>(selector);
      card?.focus();
      card?.scrollIntoView({
        behavior: detailScrollBehavior(
          window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
        block: 'center',
      });
      originCardIdRef.current = null;
    });
  }, [commit]);

  const activeProduct =
    state.activeProductId === null
      ? null
      : (state.products.find((product) => product._id === state.activeProductId) ?? null);

  // Move focus to the detail heading once the expanded band has mounted.
  // Keyed on the open token so re-activating the same card still responds.
  useEffect(() => {
    if (openToken === 0 || !activeProduct) return;
    const heading = document.querySelector<HTMLElement>('[data-detail-heading]');
    heading?.focus();
    heading?.scrollIntoView({
      behavior: detailScrollBehavior(window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      block: 'start',
    });
  }, [openToken, activeProduct]);

  const categoryLabel = (key: string) =>
    list.categories.find((option) => option.key === key)?.label ?? key;

  return (
    <>
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-[var(--width-container)] px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.15em] text-brand-600">
              {list.eyebrow}
            </p>
            <h2
              tabIndex={-1}
              data-catalog-heading
              className="mt-4 font-display text-3xl font-bold text-ink outline-none sm:text-4xl"
            >
              {list.heading}
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-soft">{list.subheading}</p>
          </div>

          <HeadphonesCatalog
            list={list}
            imageUnavailableLabel={detail.imageUnavailableLabel}
            state={state}
            onRetryInitial={handleRetryInitial}
            onLoadMore={handleLoadMore}
            onOpenProduct={handleOpenProduct}
          />
        </div>
      </section>

      {activeProduct && (
        <HeadphonesProductDetail
          product={activeProduct}
          detail={detail}
          categoryLabel={categoryLabel(activeProduct.category)}
          registered={canSeeVip}
          onBack={handleBack}
        />
      )}

      <section
        id="headphones-inquiry"
        className="border-t border-slate-200 bg-surface-alt py-16 sm:py-20"
      >
        <div className="mx-auto max-w-2xl px-4 text-center sm:px-6 lg:px-8">
          <p className="text-sm font-semibold uppercase tracking-[0.15em] text-brand-600">
            {oemCta.eyebrow}
          </p>
          <h2 className="mt-4 font-display text-3xl font-bold text-ink sm:text-4xl">
            {oemCta.heading}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-ink-soft">{oemCta.body}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <a
              href={OEM_INQUIRY_HREF}
              className="inline-flex items-center justify-center rounded-lg bg-accent-500 px-7 py-3.5 text-base font-semibold text-brand-950 shadow-sm transition hover:bg-accent-400"
            >
              {oemCta.primaryLabel}
            </a>
            <a
              href="/oem"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-7 py-3.5 text-base font-semibold text-ink transition hover:border-brand-300 hover:text-brand-700"
            >
              {oemCta.secondaryLabel}
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
