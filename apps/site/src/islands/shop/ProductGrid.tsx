import { useEffect, useMemo, useState } from 'react';
import { CategoryFilter } from './CategoryFilter.tsx';
import { InquiryCartBar } from './InquiryCartBar.tsx';
import { ProductCard } from './ProductCard.tsx';
import { type Product, fetchCatalog } from './api.ts';
import { useSession } from './session.ts';
import type { CatalogConfig, CatalogListStrings, InquiryStrings } from './types.ts';

interface Props {
  content: CatalogListStrings;
  config: CatalogConfig;
  /** Inquiry strings — required when the batch cart is enabled. */
  inquiry?: InquiryStrings;
}

/** Catalog list island: category filter + responsive grid. Reused per catalog. */
export function ProductGrid({ content, config, inquiry }: Props) {
  const allKeys = useMemo(() => content.categories.map((c) => c.key), [content.categories]);
  const [selected, setSelected] = useState<string[]>(allKeys);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { canSeeVip, loggedIn } = useSession();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    // No categories selected -> nothing to show, skip the request.
    if (selected.length === 0) {
      setProducts([]);
      setLoading(false);
      return;
    }

    fetchCatalog(config.apiPath, selected.length === allKeys.length ? undefined : selected)
      .then((items) => {
        if (active) setProducts(items);
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
  }, [selected, allKeys, config.apiPath]);

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
        <div className="flex items-center gap-4">
          <p className="text-sm text-ink-muted">
            {loading ? '…' : products.length} {content.resultsLabel}
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
      </div>

      {config.enableCart && inquiry && <InquiryCartBar inquiry={inquiry} />}
    </div>
  );
}
