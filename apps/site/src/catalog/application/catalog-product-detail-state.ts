import type {
  DetailFailure,
  DetailPageRequest,
  DetailPageResult,
} from '../infrastructure/catalog-detail-api.ts';
import { type DetailPages, acceptDetailPage, startDetailPages } from './catalog-detail-pages.ts';
import { type VariantSelection, resolveVariantSelection } from './catalog-variant-state.ts';

export type ProductDetailState =
  | { status: 'idle'; generation: number }
  | {
      status: 'loading';
      generation: number;
      productId: string;
      request: DetailPageRequest;
      requestedId?: string;
    }
  | { status: 'error'; generation: number; productId: string; error: DetailFailure }
  | {
      status: 'ready';
      generation: number;
      productId: string;
      pages: DetailPages;
      selection: VariantSelection;
      requestedId?: string;
      request?: DetailPageRequest;
      pageError?: { error: DetailFailure; page: number };
    };

export type ProductDetailEvent =
  | { type: 'open'; generation: number; productId: string; requestedId?: string }
  | { type: 'page'; generation: number; page: number }
  | { type: 'result'; generation: number; productId: string; result: DetailPageResult }
  | { type: 'close'; generation: number }
  | { type: 'select'; productId: string; revision: string; variantId?: string };

export function initialProductDetailState(): ProductDetailState {
  return { status: 'idle', generation: 0 };
}

function isNewGeneration(state: ProductDetailState, generation: number): boolean {
  return Number.isSafeInteger(generation) && generation > state.generation;
}

function fail(
  state: Extract<ProductDetailState, { status: 'ready' | 'loading' }>,
  error: DetailFailure,
): ProductDetailState {
  if (
    state.status === 'ready' &&
    ['network-error', 'unavailable', 'rate-limited', 'cancelled'].includes(error.status)
  ) {
    return { ...state, request: undefined, pageError: { error, page: state.request?.page ?? 1 } };
  }
  return { status: 'error', generation: state.generation, productId: state.productId, error };
}

/** Pure reducer. The controller allocates one generation before dispatch/fetch, never inside an updater. */
export function reduceProductDetail(
  state: ProductDetailState,
  event: ProductDetailEvent,
): ProductDetailState {
  switch (event.type) {
    case 'open':
      if (!isNewGeneration(state, event.generation)) return state;
      return {
        status: 'loading',
        generation: event.generation,
        productId: event.productId,
        requestedId: event.requestedId,
        request: { productId: event.productId, page: 1, pageSize: 50 },
      };
    case 'close':
      return isNewGeneration(state, event.generation)
        ? { status: 'idle', generation: event.generation }
        : state;
    case 'page': {
      if (state.status !== 'ready' || !isNewGeneration(state, event.generation)) return state;
      const { mode, currentPage } = state.pages;
      const { page, pageSize, total } = currentPage.variants;
      if (
        !Number.isSafeInteger(event.page) ||
        event.page < 1 ||
        event.page > Math.ceil(total / pageSize) ||
        mode === 'complete' ||
        (mode === 'collecting' && event.page !== page + 1)
      )
        return state;
      return {
        ...state,
        generation: event.generation,
        pageError: undefined,
        request: {
          productId: state.productId,
          page: event.page,
          pageSize,
          revision: currentPage.revision,
        },
      };
    }
    case 'select': {
      if (
        state.status !== 'ready' ||
        event.productId !== state.productId ||
        event.revision !== state.pages.currentPage.revision
      )
        return state;
      const selection = resolveVariantSelection(state.pages, event.variantId);
      // User clicks only select a loaded canonical row; unknown IDs never replace a valid selection.
      if (event.variantId !== undefined && selection.status !== 'selected') return state;
      return { ...state, requestedId: event.variantId, selection };
    }
    case 'result': {
      if (
        (state.status !== 'ready' && state.status !== 'loading') ||
        !state.request ||
        event.generation !== state.generation ||
        event.productId !== state.productId
      )
        return state;
      const { result } = event;
      if (result.status !== 'ready') return fail(state, result);
      const { detail } = result;
      if (
        detail._id !== state.productId ||
        detail.variants.page !== state.request.page ||
        detail.variants.pageSize !== state.request.pageSize
      )
        return fail(state, { status: 'invalid-response' });
      const assembled =
        state.status === 'ready'
          ? acceptDetailPage(state.pages, detail, result.bytes)
          : startDetailPages(detail, result.bytes);
      if (assembled.status !== 'ready') return fail(state, assembled);
      const pages = assembled.value;
      let selection = resolveVariantSelection(pages, state.requestedId);
      if (state.status === 'ready' && state.selection.status === 'selected') {
        const previous = state.selection.variant;
        const loaded = pages.items.find((item) => item.id === previous.id);
        // Same revision/ID must not change its meaning when revisiting a paged SKU.
        if (loaded && JSON.stringify(loaded) !== JSON.stringify(previous))
          return fail(state, { status: 'refresh-required' });
        if (pages.mode === 'paged' && !loaded) selection = state.selection;
      }
      return {
        status: 'ready',
        generation: state.generation,
        productId: state.productId,
        requestedId: state.requestedId,
        pages,
        selection,
      };
    }
  }
}
