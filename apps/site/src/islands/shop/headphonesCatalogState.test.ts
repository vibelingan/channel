import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { CatalogPage, Product } from './catalog-types.ts';
import {
  beginInitialLoad,
  beginLoadMore,
  commitCatalogPage,
  failInitialLoad,
  failLoadMore,
  hasMoreProducts,
  initialHeadphonesCatalogState,
  resetCatalogGeneration,
  setActiveProduct,
} from './headphonesCatalogState.ts';

function product(id: string): Product {
  return { _id: id, name: `Product ${id}`, category: 'wired' };
}

function page(ids: string[], total: number, pageNumber: number, pageSize = 12): CatalogPage {
  return { items: ids.map(product), total, page: pageNumber, pageSize };
}

const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `p${from + i}`);

// --- initial load -----------------------------------------------------------

test('initial state is idle, empty, and has no more products', () => {
  const state = initialHeadphonesCatalogState();
  assert.equal(state.status, 'idle');
  assert.deepEqual(state.products, []);
  assert.equal(state.total, null);
  assert.equal(state.nextPage, 1);
  assert.equal(state.initialError, null);
  assert.equal(state.loadMoreError, null);
  assert.equal(state.activeProductId, null);
  assert.equal(hasMoreProducts(state), false);
});

test('a committed first page becomes ready and advances the next page', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  assert.equal(state.status, 'loading-initial');
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 60, 1));
  assert.equal(state.status, 'ready');
  assert.equal(state.products.length, 12);
  assert.equal(state.total, 60);
  assert.equal(state.nextPage, 2);
  assert.equal(hasMoreProducts(state), true);
});

test('an initial failure is expressed separately and a retry clears it', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = failInitialLoad(state, state.generation, 'network down');
  assert.equal(state.status, 'initial-error');
  assert.equal(state.initialError, 'network down');
  assert.deepEqual(state.products, []);
  state = beginInitialLoad(state);
  assert.equal(state.status, 'loading-initial');
  assert.equal(state.initialError, null);
});

// --- offset pagination as eventual consistency ------------------------------

test('overlapping pages beyond 48 items append each _id once in first-seen order', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 60, 1));
  // Concurrent inserts shift the server's offset windows: every later page
  // overlaps the previous one by two ids.
  for (const [pageNumber, from, to] of [
    [2, 11, 22],
    [3, 21, 32],
    [4, 31, 42],
    [5, 41, 52],
  ] as const) {
    state = beginLoadMore(state);
    state = commitCatalogPage(state, state.generation, page(ids(from, to), 60, pageNumber));
  }
  const seen = state.products.map((item) => item._id);
  assert.equal(seen.length, 52);
  assert.deepEqual(seen, ids(1, 52));
  assert.deepEqual([...new Set(seen)], seen);
  assert.equal(state.nextPage, 6);
  assert.equal(hasMoreProducts(state), true);
  assert.equal(state.total, 60);
});

test('a fully duplicate page still advances the next page so loading can progress', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 24, 1));
  state = beginLoadMore(state);
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 24, 2));
  assert.equal(state.products.length, 12);
  assert.equal(state.nextPage, 3);
  assert.equal(hasMoreProducts(state), true);
});

// An unreachable counted document (front-inserted behind the offset cursor)
// must not leave Load More live-looping on empty pages forever.
test('an empty page is terminal: total clamps to loaded so hasMore turns false', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 14, 1));
  state = beginLoadMore(state);
  state = commitCatalogPage(state, state.generation, page(ids(13, 13), 14, 2));
  assert.equal(state.products.length, 13);
  assert.equal(hasMoreProducts(state), true);
  state = beginLoadMore(state);
  state = commitCatalogPage(state, state.generation, page([], 14, 3));
  assert.equal(state.status, 'ready');
  assert.equal(state.total, 13);
  assert.equal(hasMoreProducts(state), false);
});

test('hasMore follows loaded unique count versus the latest committed total', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 13, 1));
  assert.equal(hasMoreProducts(state), true);
  state = beginLoadMore(state);
  // The second page reports a shrunken total (a product was unpublished).
  state = commitCatalogPage(state, state.generation, page(ids(13, 13), 13, 2));
  assert.equal(state.total, 13);
  assert.equal(state.products.length, 13);
  assert.equal(hasMoreProducts(state), false);
});

// --- request generations ----------------------------------------------------

test('auth-generation reset clears page state', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 60, 1));
  state = setActiveProduct(state, 'p3');
  const before = state.generation;
  state = resetCatalogGeneration(state);
  assert.equal(state.generation, before + 1);
  assert.deepEqual(state.products, []);
  assert.equal(state.total, null);
  assert.equal(state.nextPage, 1);
  assert.equal(state.status, 'idle');
  assert.equal(state.initialError, null);
  assert.equal(state.loadMoreError, null);
  assert.equal(state.activeProductId, null);
});

test('a stale or aborted generation cannot commit products after a reset', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  const staleGeneration = state.generation;
  state = resetCatalogGeneration(state);
  const afterReset = state;
  state = commitCatalogPage(state, staleGeneration, page(ids(1, 12), 60, 1));
  assert.equal(state, afterReset);
  assert.deepEqual(state.products, []);
});

test('a stale or aborted generation cannot commit errors after a reset', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  const staleGeneration = state.generation;
  state = resetCatalogGeneration(state);
  const afterReset = state;
  state = failInitialLoad(state, staleGeneration, 'aborted');
  assert.equal(state, afterReset);
  state = failLoadMore(state, staleGeneration, 'aborted');
  assert.equal(state, afterReset);
  assert.equal(state.initialError, null);
  assert.equal(state.loadMoreError, null);
});

test('the fresh generation still works after a reset', () => {
  let state = resetCatalogGeneration(initialHeadphonesCatalogState());
  state = beginInitialLoad(state);
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 12, 1));
  assert.equal(state.products.length, 12);
  assert.equal(hasMoreProducts(state), false);
});

// The generation guard is only load-bearing when the FRESH generation is
// itself loading (the status guard alone cannot reject the stale response).
// This is the exact race: auth changes while a response is in flight, the
// controller starts a new initial load, then the orphaned response lands.
test('a stale response cannot commit into a fresh generation that is loading', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  const staleGeneration = state.generation;
  state = resetCatalogGeneration(state);
  state = beginInitialLoad(state);
  assert.equal(state.status, 'loading-initial');
  const loadingFresh = state;
  assert.equal(commitCatalogPage(state, staleGeneration, page(ids(1, 12), 60, 1)), loadingFresh);
  assert.equal(failInitialLoad(state, staleGeneration, 'stale failure'), loadingFresh);
  // The fresh generation's own commit still lands.
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 60, 1));
  assert.equal(state.products.length, 12);
});

test('a stale load-more response cannot commit while the fresh generation loads more', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 60, 1));
  state = beginLoadMore(state);
  const staleGeneration = state.generation;
  // Auth change mid-flight: reset, reload, advance to a fresh load-more.
  state = resetCatalogGeneration(state);
  state = beginInitialLoad(state);
  state = commitCatalogPage(state, state.generation, page(ids(100, 111), 60, 1));
  state = beginLoadMore(state);
  const loadingFresh = state;
  assert.equal(commitCatalogPage(state, staleGeneration, page(ids(13, 24), 60, 2)), loadingFresh);
  assert.equal(failLoadMore(state, staleGeneration, 'stale failure'), loadingFresh);
  // Only the fresh generation's page lands.
  state = commitCatalogPage(state, state.generation, page(ids(112, 123), 60, 2));
  assert.equal(state.products.length, 24);
  assert.ok(state.products.every((item) => Number(item._id.slice(1)) >= 100));
});

// --- load-more errors keep loaded cards usable ------------------------------

test('a later-page failure keeps loaded cards usable and is separately recoverable', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 60, 1));
  state = beginLoadMore(state);
  assert.equal(state.status, 'loading-more');
  state = failLoadMore(state, state.generation, 'page 2 failed');
  assert.equal(state.status, 'ready');
  assert.equal(state.loadMoreError, 'page 2 failed');
  assert.equal(state.initialError, null);
  assert.equal(state.products.length, 12);
  // Retry: beginning another load-more clears the recoverable error.
  state = beginLoadMore(state);
  assert.equal(state.loadMoreError, null);
  state = commitCatalogPage(state, state.generation, page(ids(13, 24), 60, 2));
  assert.equal(state.products.length, 24);
  assert.equal(state.loadMoreError, null);
});

// --- transition guards ------------------------------------------------------

test('load-more cannot begin unless the catalog is ready', () => {
  const idle = initialHeadphonesCatalogState();
  assert.equal(beginLoadMore(idle), idle);
  const loading = beginInitialLoad(idle);
  assert.equal(beginLoadMore(loading), loading);
});

test('a commit from the current generation while not loading is ignored', () => {
  const idle = initialHeadphonesCatalogState();
  assert.equal(commitCatalogPage(idle, idle.generation, page(ids(1, 12), 60, 1)), idle);
});

// --- active product ---------------------------------------------------------

test('the active product must be a loaded product; clearing is always allowed', () => {
  let state = beginInitialLoad(initialHeadphonesCatalogState());
  state = commitCatalogPage(state, state.generation, page(ids(1, 12), 60, 1));
  state = setActiveProduct(state, 'p7');
  assert.equal(state.activeProductId, 'p7');
  const unchanged = setActiveProduct(state, 'not-loaded');
  assert.equal(unchanged.activeProductId, 'p7');
  state = setActiveProduct(state, null);
  assert.equal(state.activeProductId, null);
});
