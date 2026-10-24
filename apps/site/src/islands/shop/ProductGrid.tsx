import { useEffect, useMemo, useState } from 'react';
import { CategoryFilter } from './CategoryFilter.tsx';
import { InquiryCartBar } from './InquiryCartBar.tsx';
import { ProductCard } from './ProductCard.tsx';
import { type Product, fetchCatalog } from './api.ts';
import { useSession } from './session.ts';
import type { CatalogConfig, CatalogListStrings, InquiryStrings } from './types.ts';

const PAGE_SIZE = 24;

interface Props {
  content: CatalogListStrings;
  config: CatalogConfig;
  /** Inquiry strings — required when the batch cart is enabled. */
  inquiry?: InquiryStrings;
}

/** Catalog list island: category filter + search + paginated grid. Reused per catalog. */
export function ProductGrid({ content, config, inquiry }: Props) {
  const allKeys = useMemo(() => content.categories.map((c) => c.key), [content.categories]);
  const [selected, setSelected] = useState<string[]>(allKeys);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { canSeeVip, loggedIn } = useSession();

  // Debounce the free-text search so we don't hit the API on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Category changes reset back to the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when selection changes
  useEffect(() => {
    setPage(1);
  }, [selected]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    // No categories selected -> nothing to show, skip the request.
    if (selected.length === 0) {
      setProducts([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    fetchCatalog(config.apiPath, {
      ...(selected.length === allKeys.length ? {} : { categories: selected }),
      ...(search ? { search } : {}),
      page,
      pageSize: PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        setProducts(result.items);
        setTotal(result.total);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load products');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selected, allKeys, config.apiPath, search, page]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <CategoryFilter
          label={content.filterLabel}
          allLabel={content.allLabel}
          options={content.categories}
          selected={selected}
          onChange={setSelected}
        />
        <div className="flex flex-wrap items-center gap-4">
          <label className="relative">
            <span className="sr-only">{content.searchPlaceholder ?? 'Search'}</span>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 1 0 3.4 9.83l3.13 3.13a.75.75 0 1 0 1.06-1.06l-3.13-3.13A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                clipRule="evenodd"
              />
            </svg>
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={content.searchPlaceholder ?? 'Search products…'}
              className="w-56 rounded-full border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-sm text-ink outline-none transition focus:border-brand-400"
            />
          </label>
          <p className="text-sm text-ink-muted">
            {loading ? '…' : total} {content.resultsLabel}
          </p>
          {!loggedIn && (
            <a
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:border-brand-400 hover:text-brand-700"
            >
              Sign in for VIP pricing
            </a>
          )}
        </div>
      </div>

      <div className="mt-8">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!error && loading && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((key) => (
              <div
                key={key}
                className="h-80 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-100"
              />
            ))}
          </div>
        )}

        {!error && !loading && products.length === 0 && (
          <p className="rounded-lg border border-slate-200 bg-surface-alt p-8 text-center text-ink-muted">
            {content.emptyLabel}
          </p>
        )}

        {!error && !loading && products.length > 0 && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {products.map((product) => (
              <ProductCard
                key={product._id}
                product={product}
                content={content}
                config={config}
                registered={canSeeVip}
              />
            ))}
          </div>
        )}

        {!error && pageCount > 1 && (
          <nav className="mt-10 flex items-center justify-center gap-2" aria-label="Pagination">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:border-brand-400 hover:text-brand-700 disabled:opacity-40 disabled:hover:border-slate-300 disabled:hover:text-ink-muted"
            >
              Prev
            </button>
            <span className="px-2 text-sm text-ink-muted">
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              disabled={page >= pageCount || loading}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              className="rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:border-brand-400 hover:text-brand-700 disabled:opacity-40 disabled:hover:border-slate-300 disabled:hover:text-ink-muted"
            >
              Next
            </button>
          </nav>
        )}
      </div>

      {config.enableCart && inquiry && <InquiryCartBar inquiry={inquiry} />}
    </div>
  );
}
