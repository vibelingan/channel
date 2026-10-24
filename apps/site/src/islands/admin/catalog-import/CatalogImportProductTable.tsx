/**
 * Staged product groups, with their variants and the shop lines behind them.
 *
 * The two things this table exists to make obvious are the two things that go
 * wrong quietly: a variant whose stock the shops disagree about, and a product
 * that was rejected. Both are given colour and words rather than being left to
 * be inferred from a number.
 */
import { CatalogImportFindings } from './CatalogImportFindings.tsx';
import { type ProductView, formatSourceMoney } from './catalog-import-api.ts';

const STATUS_STYLE: Record<string, string> = {
  rejected: 'bg-rose-100 text-rose-800',
  warning: 'bg-amber-100 text-amber-800',
  applied: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
  valid: 'bg-slate-100 text-slate-700',
};

function SourceImages({ urls }: { urls: readonly string[] }) {
  if (urls.length === 0) return <p className="text-xs text-slate-400">No source images.</p>;
  return (
    <div className="flex flex-wrap gap-2" data-testid="source-images">
      {urls.slice(0, 8).map((url) => (
        <img
          key={url}
          src={url}
          alt=""
          // Source URLs are shown as-is for the local proof and are NOT yet
          // migrated into Channel media. `no-referrer` keeps the supplier CDN
          // from learning which admin page is looking at them.
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-16 w-16 rounded border border-slate-200 object-cover"
        />
      ))}
      {urls.length > 8 ? (
        <span className="self-center text-xs text-slate-500">+{urls.length - 8} more</span>
      ) : null}
    </div>
  );
}

export function CatalogImportProductTable({ products }: { products: readonly ProductView[] }) {
  if (products.length === 0) {
    return <p className="text-sm text-slate-500">This job staged no products.</p>;
  }

  return (
    <div className="space-y-4" data-testid="import-products">
      {products.map((product) => (
        <article
          key={product.id}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-semibold text-ink">{product.title || '(untitled)'}</h3>
            <span className="font-mono text-xs text-slate-500">{product.parentSku}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                STATUS_STYLE[product.status] ?? 'bg-slate-100 text-slate-700'
              }`}
            >
              {product.status}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
              source: {product.sourceListingStatus}
            </span>
            {product.sourceListingStatus === 'draft' ? (
              <span className="text-xs text-slate-500">
                (a draft at the marketplace — still eligible here)
              </span>
            ) : null}
          </header>

          <p className="mt-2 text-sm text-slate-600">
            {product.hasDescription ? (
              product.descriptionText.slice(0, 300)
            ) : (
              <em className="text-slate-400">No usable source description.</em>
            )}
          </p>

          <div className="mt-3">
            <SourceImages urls={product.imageUrls} />
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">Variants for {product.parentSku}</caption>
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1 pr-3">SKU</th>
                  <th className="py-1 pr-3">Options</th>
                  <th className="py-1 pr-3">Source price</th>
                  <th className="py-1 pr-3">Promo</th>
                  <th className="py-1 pr-3">Inventory</th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((variant) => (
                  <tr key={variant.sku} className="border-b border-slate-100 last:border-0">
                    <td className="py-1 pr-3 font-mono text-xs">{variant.sku}</td>
                    <td className="py-1 pr-3 text-slate-600">{variant.optionSummary || '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {formatSourceMoney(variant.regularPrice)}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">
                      {formatSourceMoney(variant.promotionPrice)}
                    </td>
                    <td
                      className={`py-1 pr-3 tabular-nums ${
                        variant.inventoryConflict ? 'font-semibold text-rose-700' : ''
                      }`}
                    >
                      {variant.inventoryLabel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">
              Store lines ({product.storeListings.length})
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-3">Row</th>
                    <th className="py-1 pr-3">Store</th>
                    <th className="py-1 pr-3">SKU</th>
                    <th className="py-1 pr-3">Source status</th>
                    <th className="py-1 pr-3">Marketplace ID</th>
                    <th className="py-1 pr-3">Price</th>
                    <th className="py-1 pr-3">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {product.storeListings.map((listing) => (
                    <tr
                      key={`${listing.storeKey}:${listing.sku}`}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-1 pr-3 tabular-nums text-slate-500">{listing.rowNumber}</td>
                      <td className="py-1 pr-3">{listing.storeKey}</td>
                      <td className="py-1 pr-3 font-mono">{listing.sku}</td>
                      <td className="py-1 pr-3">{listing.sourceListingStatus}</td>
                      <td className="py-1 pr-3 font-mono">{listing.marketplaceProductId || '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {formatSourceMoney(listing.regularPrice)}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">
                        {listing.quantity === null ? 'unknown' : listing.quantity}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <CatalogImportFindings findings={product.findings} />
        </article>
      ))}
    </div>
  );
}
