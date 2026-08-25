import {
  type CatalogPricingDecision,
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import {
  DEFAULT_ALIBABA_PRICING_LABELS,
  formatMinorAmount,
} from './AlibabaCatalogPricingBlock.tsx';
import { ProductMedia } from './ProductMedia.tsx';
import { quantityTierPriceSummary } from './QuantityTierPricingBlock.tsx';
import { formatPrice } from './api.ts';
import type { Product } from './catalog-types.ts';
import { type HeadphonesCatalogState, hasMoreProducts } from './headphonesCatalogState.ts';

interface Props {
  content: CatalogContent;
  family: CatalogFamilyContent;
  state: HeadphonesCatalogState;
  selectedCategories: readonly string[];
  searchInput: string;
  onCategoriesChange: (categories: string[]) => void;
  onSearchInputChange: (search: string) => void;
  onRetryInitial: () => void;
  onLoadMore: () => void;
  onOpenProduct: (productId: string) => void;
}

const SKELETON_KEYS = ['family-1', 'family-2', 'family-3', 'family-4'] as const;
const alibabaAdapter = createAlibabaPricingAdapter();

function pricingDecision(product: Product): CatalogPricingDecision {
  return resolveCatalogPricing(product, alibabaAdapter);
}

function pricingDecisionLabel(decision: CatalogPricingDecision, quoteLabel: string): string {
  switch (decision.source) {
    case 'alibaba':
      if (decision.pricing.state !== 'available') {
        return DEFAULT_ALIBABA_PRICING_LABELS.unavailableLabel;
      }
      switch (decision.pricing.mode) {
        case 'fixed':
          return formatMinorAmount(decision.pricing.amountMinor, decision.pricing.currency);
        case 'range':
          return `${formatMinorAmount(decision.pricing.minAmountMinor, decision.pricing.currency)} – ${formatMinorAmount(decision.pricing.maxAmountMinor, decision.pricing.currency)}`;
        case 'tiered': {
          const minimum = Math.min(...decision.pricing.tiers.map((tier) => tier.unitAmountMinor));
          return `From ${formatMinorAmount(minimum, decision.pricing.currency)}`;
        }
      }
    case 'manual-tiered':
      return quantityTierPriceSummary(decision.pricing);
    case 'scalar':
      return formatPrice(decision.amount);
    case 'quote-required':
      return quoteLabel;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export function hasUsableCatalogSlug(product: Product): product is Product & { slug: string } {
  return Boolean(product.slug?.trim());
}

/**
 * One catalog card. Activating it expands the detail band lower on the same page,
 * keyed by product id. That works for every published product, including legacy rows
 * that predate slugs and therefore have no detail URL of their own.
 *
 * The card owns its own border and fills its grid track as a flex column, so the grid
 * never has to paint separators behind it. Every region has a fixed place: square
 * media, a two-line title, then the meta row and action pinned to the bottom. Cards
 * therefore line up whatever the length of a product name.
 */
function CatalogProductCard({
  product,
  content,
  onOpenProduct,
}: { product: Product; content: CatalogContent; onOpenProduct: (productId: string) => void }) {
  const { list, detail } = content;
  const decision = pricingDecision(product);
  const moq = decision.source === 'alibaba' ? decision.pricing.sourceMoq : product.moq;
  const identifier = product.skuCode ?? product.modName ?? product.productCode;
  return (
    <button
      type="button"
      data-product-card={product._id}
      onClick={() => onOpenProduct(product._id)}
      className="group flex h-full min-w-0 flex-col border border-slate-200 bg-white p-4 text-left transition hover:border-brand-300 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-brand-700"
    >
      <div className="aspect-square shrink-0 overflow-hidden bg-surface-alt">
        <ProductMedia
          sources={product.images ?? []}
          alt={product.name}
          imageClassName="p-4 transition duration-300 group-hover:scale-[1.025] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      </div>
      {/* Reserve the identifier line whether or not this product has one, so titles
          start at the same y across the row. */}
      <p className="mt-4 min-h-4 text-xs font-semibold uppercase text-brand-600">{identifier}</p>
      <h3 className="mt-1 line-clamp-2 font-display text-lg font-semibold text-ink group-hover:text-brand-700">
        {product.name}
      </h3>
      {product.description && (
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-ink-soft">
          {product.description}
        </p>
      )}
      <div className="mt-auto flex items-end justify-between gap-3 pt-4 text-sm">
        {moq !== undefined && (
          <span className="text-ink-muted">
            {list.moqLabel} {moq}
          </span>
        )}
        <span className="ml-auto text-right font-semibold text-brand-700" data-product-card-price>
          {pricingDecisionLabel(decision, detail.inquiryCta)}
        </span>
      </div>
      {/* The action affordance stays the quietest line in the card: identity reads
          strongest, then price, then this. */}
      <span className="mt-3 block text-xs font-medium text-brand-700" data-product-card-action>
        {list.viewDetail}
      </span>
    </button>
  );
}

export function catalogProductPrice(product: Product, quoteLabel: string): string {
  return pricingDecisionLabel(pricingDecision(product), quoteLabel);
}

export function CatalogFamilyGrid({
  content,
  family,
  state,
  selectedCategories,
  searchInput,
  onCategoriesChange,
  onSearchInputChange,
  onRetryInitial,
  onLoadMore,
  onOpenProduct,
}: Props) {
  const { list } = content;
  // Render every published product the API returns. Legacy catalog rows predate slugs,
  // so filtering the grid by slug hid real, sellable products behind "no products match".
  // The slug only decides whether a card links to its detail page.
  const products = state.products;
  const loadingInitial = state.status === 'idle' || state.status === 'loading-initial';
  const loadingMore = state.status === 'loading-more';
  const announcement = loadingInitial
    ? list.loadingLabel
    : state.status === 'initial-error'
      ? (state.initialError ?? list.errorLabel)
      : products.length === 0
        ? list.emptyLabel
        : `${products.length} ${list.resultsLabel}`;

  const toggleCategory = (category: string) => {
    onCategoriesChange(
      selectedCategories.includes(category)
        ? selectedCategories.filter((candidate) => candidate !== category)
        : [...selectedCategories, category],
    );
  };

  return (
    <div className="mt-10">
      <div
        className={`flex flex-col gap-5 border-y border-slate-200 py-5 sm:flex-row sm:items-end ${
          family.categories.length > 0 ? 'sm:justify-between' : 'sm:justify-end'
        }`}
      >
        {family.categories.length > 0 && (
          <fieldset>
            <legend className="text-sm font-semibold text-ink">{list.filterLabel}</legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {family.categories.map((category) => (
                <label
                  key={category.key}
                  className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-soft"
                >
                  <input
                    type="checkbox"
                    checked={selectedCategories.includes(category.key)}
                    onChange={() => toggleCategory(category.key)}
                    className="h-4 w-4 accent-brand-600"
                  />
                  {category.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="block sm:ml-auto">
          <span className="text-sm font-semibold text-ink">{list.searchPlaceholder}</span>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => onSearchInputChange(event.currentTarget.value)}
            placeholder={list.searchPlaceholder}
            className="mt-2 block min-h-11 w-full border border-slate-300 bg-white px-3 text-sm text-ink outline-none focus:border-brand-500 sm:w-72"
          />
        </label>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {loadingInitial && (
        <div className="mt-8">
          <p className="sr-only" aria-live="polite">
            {list.loadingLabel}
          </p>
          <div aria-hidden="true" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {SKELETON_KEYS.map((key) => (
              <div
                key={key}
                className="h-80 animate-pulse bg-slate-100 motion-reduce:animate-none"
              />
            ))}
          </div>
        </div>
      )}

      {state.status === 'initial-error' && (
        <div role="alert" className="mt-8 border border-red-200 bg-red-50 p-6 text-sm text-red-800">
          <p>{state.initialError ?? list.errorLabel}</p>
          <button
            type="button"
            onClick={onRetryInitial}
            className="mt-4 min-h-11 border border-red-300 bg-white px-4 py-2 font-semibold hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
          >
            {list.retryLabel}
          </button>
        </div>
      )}

      {!loadingInitial && state.status !== 'initial-error' && products.length === 0 && (
        <p className="mt-8 border-y border-slate-200 bg-white px-5 py-10 text-center text-ink-muted">
          {list.emptyLabel}
        </p>
      )}

      {!loadingInitial && state.status !== 'initial-error' && products.length > 0 && (
        <>
          <p className="mt-6 text-sm text-ink-muted" data-result-progress>
            {products.length} {list.resultsLabel}
          </p>
          {/* Real gaps, not a painted container. A partly filled last row used to
              expose the container background as grey placeholder blocks. */}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {products.map((product) => (
              <CatalogProductCard
                key={product._id}
                product={product}
                content={content}
                onOpenProduct={onOpenProduct}
              />
            ))}
          </div>
        </>
      )}

      {!loadingInitial &&
        state.status !== 'initial-error' &&
        (state.loadMoreError !== null || hasMoreProducts(state)) && (
          <div className="mt-8 text-center">
            {state.loadMoreError && (
              <p role="alert" className="text-sm text-red-700">
                {state.loadMoreError}
              </p>
            )}
            {hasMoreProducts(state) && (
              <button
                type="button"
                disabled={loadingMore}
                aria-busy={loadingMore || undefined}
                onClick={onLoadMore}
                data-load-more
                className="mt-4 min-h-11 border border-brand-300 bg-white px-6 py-2 text-sm font-semibold text-brand-700 disabled:opacity-60"
              >
                {loadingMore ? list.loadingLabel : list.loadMoreLabel}
              </button>
            )}
          </div>
        )}
    </div>
  );
}
