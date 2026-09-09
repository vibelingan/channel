import { type SubmitEventHandler, useState } from 'react';
import {
  type ProductDetailInspectionSummary,
  type SelectedProductSyncSummary,
  isAlibabaSourceProductId,
} from './alibaba-api.ts';

export interface AlibabaProductDetailInspectionProps {
  connected: boolean;
  busy: boolean;
  inspecting?: boolean;
  result: ProductDetailInspectionSummary | null;
  syncResult?: SelectedProductSyncSummary | null;
  onInspect: (sourceProductId: string) => void;
  onSync?: (sourceProductId: string) => void;
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

export function AlibabaProductDetailInspection({
  connected,
  busy,
  inspecting = false,
  result,
  syncResult = null,
  onInspect,
  onSync,
}: AlibabaProductDetailInspectionProps) {
  const [sourceProductId, setSourceProductId] = useState('');

  const submit: SubmitEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    const normalized = sourceProductId.trim();
    if (!connected || busy || !isAlibabaSourceProductId(normalized)) return;
    onInspect(normalized);
  };

  return (
    <section
      data-product-detail-inspection
      aria-labelledby="alibaba-detail-inspection-title"
      className="rounded-lg border border-slate-200 bg-white p-5"
    >
      <div className="max-w-3xl">
        <h3 id="alibaba-detail-inspection-title" className="text-base font-semibold text-slate-900">
          Inspect one product detail
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Calls Alibaba product.get once, stores the exact response privately, and shows only a
          structural summary. It does not update products or offers.
        </p>
      </div>

      <form
        className="mt-4 flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={submit}
      >
        <label
          className="min-w-0 flex-1 text-sm font-medium text-slate-700"
          htmlFor="source-product-id"
        >
          Alibaba product ID
          <input
            id="source-product-id"
            data-inspect-product-id
            type="text"
            value={sourceProductId}
            required
            maxLength={128}
            pattern="[A-Za-z0-9_-]{1,128}"
            autoComplete="off"
            spellCheck={false}
            disabled={!connected || busy}
            onChange={(event) => setSourceProductId(event.currentTarget.value)}
            placeholder="Paste an Alibaba product_id"
            className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 disabled:text-slate-500"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            data-inspect-product-submit
            disabled={!connected || busy}
            className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {inspecting ? 'Inspecting…' : 'Inspect detail'}
          </button>
          {onSync && (
            <button
              type="button"
              data-sync-product-submit
              disabled={!connected || busy || !isAlibabaSourceProductId(sourceProductId.trim())}
              onClick={() => onSync(sourceProductId.trim())}
              className="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Sync to Products
            </button>
          )}
        </div>
      </form>

      {!connected && (
        <p className="mt-2 text-xs text-amber-700">
          Connect the Alibaba account before inspecting.
        </p>
      )}

      {result && (
        <div
          data-detail-inspection-result
          aria-live="polite"
          className="mt-5 border-t border-slate-200 pt-4"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
            <p className="text-sm font-semibold text-slate-900">
              Detail received for <span className="font-mono">{result.sourceProductId}</span>
            </p>
            <p className="text-xs text-slate-500">
              {result.deduplicated ? 'Matched existing raw evidence' : 'Stored new raw evidence'}
            </p>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-500">Raw response</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {result.rawByteLength.toLocaleString('en-US')} bytes
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Description</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {result.description.kind} ·{' '}
                {result.description.characterCount.toLocaleString('en-US')} chars
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Images</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{result.imageCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Attributed SKUs</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {result.skusWithAttributes} / {result.skuCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Normalized offers</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{result.normalizedOfferCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Price modes</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {result.normalizedPriceModes.join(', ') || 'none'}
                {result.currency ? ` · ${result.currency}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Tier coverage</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {result.productTierCount} product · {result.skuTieredPriceCount} SKU
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Core fields</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                title {yesNo(result.hasSubject)} · category {yesNo(result.hasCategory)} · MOQ{' '}
                {yesNo(result.hasMoq)}
              </dd>
            </div>
          </dl>

          <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
            <p>
              Attributes: {result.attributeNames.join(', ') || 'none'} ({result.attributeNameCount}{' '}
              unique)
            </p>
            {result.sourceStatus && <p>Alibaba status: {result.sourceStatus}</p>}
            <p className="break-all sm:col-span-2">
              Evidence payload: <code>{result.payloadId}</code>
            </p>
          </div>
        </div>
      )}
      {syncResult && (
        <p data-selected-sync-result aria-live="polite" className="mt-4 text-sm text-emerald-700">
          {syncResult.draftCreated ? 'Created' : 'Updated'} product draft{' '}
          <code>{syncResult.productId}</code> with {syncResult.offerCount} offer(s). It remains
          unpublished.
        </p>
      )}
    </section>
  );
}
