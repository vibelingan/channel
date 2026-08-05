/**
 * Presentational Headphones catalog (MIU 10).
 *
 * Renders exactly one of four mutually exclusive branches from the MIU 9
 * state contract — loading skeleton, actionable error, OEM-linked empty
 * state, or category-grouped cards — plus the result progress line and an
 * explicit busy/disabled Load More. A load-more failure renders as a
 * recoverable inline alert while the loaded cards stay usable.
 *
 * Purely presentational: fetching, aborting, generation resets, and focus
 * management belong to the MIU 13 controller.
 */
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';
import { HeadphonesProductCard } from './HeadphonesProductCard.tsx';
import type { Product } from './catalog-types.ts';
import { type HeadphonesCatalogState, hasMoreProducts } from './headphonesCatalogState.ts';

export interface HeadphonesCatalogProps {
  list: HeadphonesContent['list'];
  imageUnavailableLabel: string;
  state: HeadphonesCatalogState;
  onRetryInitial: () => void;
  onLoadMore: () => void;
  onOpenProduct: (productId: string) => void;
}

/** Substitute {loaded}/{total} into the content contract's progress template. */
export function formatResultProgress(template: string, loaded: number, total: number): string {
  return template.replaceAll('{loaded}', String(loaded)).replaceAll('{total}', String(total));
}

const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] as const;

export function HeadphonesCatalog({
  list,
  imageUnavailableLabel,
  state,
  onRetryInitial,
  onLoadMore,
  onOpenProduct,
}: HeadphonesCatalogProps) {
  if (state.status === 'idle' || state.status === 'loading-initial') {
    return (
      <div className="mt-12">
        <p role="status" className="sr-only">
          {list.loadingLabel}
        </p>
        <div
          aria-hidden="true"
          className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {SKELETON_KEYS.map((key) => (
            <div
              key={key}
              className="h-80 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-100"
            />
          ))}
        </div>
      </div>
    );
  }

  if (state.status === 'initial-error') {
    return (
      <div
        role="alert"
        className="mt-12 rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700"
      >
        <p>{state.initialError ?? list.errorLabel}</p>
        <button
          type="button"
          onClick={onRetryInitial}
          className="mt-4 inline-flex items-center justify-center rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100"
        >
          {list.retryLabel}
        </button>
      </div>
    );
  }

  // Ready / loading-more share the card layout; uniqueness is guaranteed by
  // the reducer but re-asserted here so a card key can never collide.
  const seen = new Set<string>();
  const products = state.products.filter((product) => {
    if (seen.has(product._id)) return false;
    seen.add(product._id);
    return true;
  });

  if (products.length === 0) {
    return (
      <div className="mt-12 rounded-lg border border-slate-200 bg-surface-alt p-12 text-center">
        <p className="text-ink-muted">{list.emptyStateLabel}</p>
        <a
          href={OEM_INQUIRY_HREF}
          className="mt-4 inline-flex items-center justify-center rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
        >
          {list.emptyCtaLabel}
        </a>
      </div>
    );
  }

  const groups = new Map<string, Product[]>();
  for (const product of products) {
    const category = product.category || 'uncategorized';
    const group = groups.get(category);
    if (group) group.push(product);
    else groups.set(category, [product]);
  }
  const categoryLabel = (key: string) =>
    list.categories.find((option) => option.key === key)?.label ?? key;
  const loadingMore = state.status === 'loading-more';

  return (
    <>
      {[...groups.entries()].map(([categoryKey, categoryProducts]) => (
        <div key={categoryKey} className="mt-12 first:mt-12">
          <div className="mb-6 flex items-center gap-3">
            <h3 className="font-display text-xl font-semibold text-ink">
              {categoryLabel(categoryKey)}
            </h3>
            <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
              {categoryProducts.length} {categoryProducts.length === 1 ? 'model' : 'models'}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {categoryProducts.map((product) => (
              <HeadphonesProductCard
                key={product._id}
                product={product}
                list={list}
                imageUnavailableLabel={imageUnavailableLabel}
                onOpen={onOpenProduct}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="mt-10 text-center">
        {state.total !== null && (
          <p data-result-progress className="text-sm text-ink-muted">
            {formatResultProgress(list.resultProgressLabel, products.length, state.total)}
          </p>
        )}
        {state.loadMoreError !== null && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {state.loadMoreError}
          </p>
        )}
        {hasMoreProducts(state) && (
          <button
            type="button"
            data-load-more
            disabled={loadingMore}
            aria-busy={loadingMore || undefined}
            onClick={onLoadMore}
            className="mt-4 inline-flex items-center justify-center rounded-lg border border-brand-200 bg-white px-6 py-3 text-sm font-semibold text-brand-700 transition hover:border-brand-300 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingMore ? list.loadingMoreLabel : list.loadMoreLabel}
          </button>
        )}
      </div>
    </>
  );
}
