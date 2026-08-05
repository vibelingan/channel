/**
 * Deterministic Load More state for the Headphones catalog.
 *
 * Offset pagination against a live catalog is EVENTUALLY consistent: documents
 * are inserted/unpublished between page requests, so page windows shift and
 * overlap. The reducer therefore never treats a page as a snapshot — it
 * appends only unseen ids in first-seen order, discards duplicates, and lets
 * `total` follow the latest server report.
 *
 * Every request is tagged with the generation it started under. An auth change
 * resets the generation, and a commit or failure carrying a stale generation
 * is ignored entirely — an aborted or slow response can never write products
 * or errors into a state that no longer belongs to it.
 *
 * Pure module: no browser globals, no clock, no I/O. The controller (MIU 13)
 * owns fetching/aborting; components (MIU 10) render this state.
 */
import type { CatalogPage, Product } from './catalog-types.ts';

export type HeadphonesCatalogStatus =
  | 'idle'
  | 'loading-initial'
  | 'initial-error'
  | 'ready'
  | 'loading-more';

export interface HeadphonesCatalogState {
  /** Auth/request generation; bumped by reset, carried by in-flight requests. */
  readonly generation: number;
  /** Loaded products, unique by `_id`, in first-seen order. */
  readonly products: readonly Product[];
  /** Latest committed server total; null before the first committed page. */
  readonly total: number | null;
  /** Next page number to request (1-based); advances per committed page. */
  readonly nextPage: number;
  readonly status: HeadphonesCatalogStatus;
  /** Blocks the whole catalog; only an initial retry clears it. */
  readonly initialError: string | null;
  /** Recoverable: loaded cards stay usable; the next load-more clears it. */
  readonly loadMoreError: string | null;
  /** The product whose in-page detail is open; must be a loaded product. */
  readonly activeProductId: string | null;
}

export function initialHeadphonesCatalogState(): HeadphonesCatalogState {
  return {
    generation: 0,
    products: [],
    total: null,
    nextPage: 1,
    status: 'idle',
    initialError: null,
    loadMoreError: null,
    activeProductId: null,
  };
}

/** More products exist iff the server total exceeds the unique loaded count. */
export function hasMoreProducts(state: HeadphonesCatalogState): boolean {
  return state.total !== null && state.products.length < state.total;
}

/** Start (or retry) the first page load. Clears the blocking initial error. */
export function beginInitialLoad(state: HeadphonesCatalogState): HeadphonesCatalogState {
  return { ...state, status: 'loading-initial', initialError: null };
}

/** Start the next page load. Valid only from `ready`; clears the recoverable error. */
export function beginLoadMore(state: HeadphonesCatalogState): HeadphonesCatalogState {
  if (state.status !== 'ready') return state;
  return { ...state, status: 'loading-more', loadMoreError: null };
}

/**
 * Commit a fetched page for the generation that requested it. A stale
 * generation or a commit outside an active load is ignored. Unseen products
 * append in page order after the existing list; duplicates are discarded. The
 * next page always advances so a fully-overlapping page cannot stall paging.
 */
export function commitCatalogPage(
  state: HeadphonesCatalogState,
  generation: number,
  page: CatalogPage,
): HeadphonesCatalogState {
  if (generation !== state.generation) return state;
  if (state.status !== 'loading-initial' && state.status !== 'loading-more') return state;
  const seen = new Set(state.products.map((product) => product._id));
  const appended = page.items.filter((product) => {
    if (seen.has(product._id)) return false;
    seen.add(product._id);
    return true;
  });
  return {
    ...state,
    products: [...state.products, ...appended],
    total: page.total,
    nextPage: state.nextPage + 1,
    status: 'ready',
  };
}

/** Fail the first-page load for its generation; blocks the catalog until retried. */
export function failInitialLoad(
  state: HeadphonesCatalogState,
  generation: number,
  message: string,
): HeadphonesCatalogState {
  if (generation !== state.generation) return state;
  if (state.status !== 'loading-initial') return state;
  return { ...state, status: 'initial-error', initialError: message };
}

/** Fail a later page for its generation; loaded cards stay usable. */
export function failLoadMore(
  state: HeadphonesCatalogState,
  generation: number,
  message: string,
): HeadphonesCatalogState {
  if (generation !== state.generation) return state;
  if (state.status !== 'loading-more') return state;
  return { ...state, status: 'ready', loadMoreError: message };
}

/**
 * Auth change: bump the generation and drop all page state. In-flight requests
 * tagged with the old generation are orphaned — their commits and failures
 * no-op against the new generation.
 */
export function resetCatalogGeneration(state: HeadphonesCatalogState): HeadphonesCatalogState {
  return { ...initialHeadphonesCatalogState(), generation: state.generation + 1 };
}

/** Open a loaded product's in-page detail, or close it with null. */
export function setActiveProduct(
  state: HeadphonesCatalogState,
  productId: string | null,
): HeadphonesCatalogState {
  if (productId !== null && !state.products.some((product) => product._id === productId)) {
    return state;
  }
  return { ...state, activeProductId: productId };
}
