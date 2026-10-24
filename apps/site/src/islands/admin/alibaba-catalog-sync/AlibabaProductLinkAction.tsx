/**
 * Explicit product link/unlink action (MIU 13). Side-by-side confirmation is
 * the operator's job: they paste the SOURCE KEY from the source-products view
 * and the PRODUCT ID from the catalog — no search, no fuzzy match, ever.
 */
import { useState } from 'react';

export interface AlibabaProductLinkActionProps {
  busy: boolean;
  result: string | null;
  onLink: (sourceKey: string, productId: string) => void;
  onUnlink: (productId: string) => void;
}

export function AlibabaProductLinkAction({
  busy,
  result,
  onLink,
  onUnlink,
}: AlibabaProductLinkActionProps) {
  const [sourceKey, setSourceKey] = useState('');
  const [productId, setProductId] = useState('');
  return (
    <div data-alibaba-link-action className="rounded-lg border border-slate-200 bg-white p-5">
      <h3 className="text-base font-semibold text-slate-900">Link a source product</h3>
      <p className="mt-1 text-xs text-slate-500">
        Links are explicit and one-to-one per source product. Unlinking restores the legacy pricing
        display immediately.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-600">
          Source key
          <input
            data-link-source-key
            value={sourceKey}
            onChange={(event) => setSourceKey(event.target.value.trim())}
            className="mt-1 w-72 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
            placeholder="sha256 source key"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-600">
          Product id
          <input
            data-link-product-id
            value={productId}
            onChange={(event) => setProductId(event.target.value.trim())}
            className="mt-1 w-48 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
            placeholder="products._id"
          />
        </label>
        <button
          type="button"
          data-link-submit
          disabled={busy || sourceKey === '' || productId === ''}
          onClick={() => onLink(sourceKey, productId)}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Link
        </button>
        <button
          type="button"
          data-unlink-submit
          disabled={busy || productId === ''}
          onClick={() => onUnlink(productId)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
        >
          Unlink product
        </button>
      </div>
      {result && (
        <p
          data-link-result
          className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700"
        >
          {result}
        </p>
      )}
    </div>
  );
}
