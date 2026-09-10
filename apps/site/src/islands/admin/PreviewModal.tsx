import { type CollectionDoc, PRODUCT_IMAGE_MAX_COUNT } from '@vibelingan-channel/shared';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { EffectiveCatalogPricingBlock } from '../shop/EffectiveCatalogPricingBlock.tsx';
import { formatPrice } from '../shop/api.ts';
import { effectiveCatalogMoq } from '../shop/catalog-pricing.ts';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';
import { decodeAlibabaSourceReview, formatAlibabaSourcePricing } from './alibaba-source-review.ts';
import { getImagePreview } from './api.ts';
import { adminCatalogPricingInput } from './product-pricing-editor.ts';
import { useModalDialog } from './use-modal-dialog.ts';

const AdminDetailPreview = lazy(() => import('./AdminDetailPreview.tsx'));

interface Props {
  doc: CollectionDoc;
  onClose: () => void;
  onEdit: () => void;
  canMarkReviewed?: boolean;
  reviewBusy?: boolean;
  reviewError?: Error | null;
  onMarkReviewed?: () => void;
}

/**
 * Catalog item preview — shows admins/contributors how a Headphones or Overstock
 * item will look to the public before they publish it.
 */
export function PreviewModal({
  doc,
  onClose,
  onEdit,
  canMarkReviewed = false,
  reviewBusy = false,
  reviewError = null,
  onMarkReviewed,
}: Props) {
  const dialogRef = useModalDialog();
  const sharedPreview = canMarkReviewed && typeof doc.alibabaPrimarySourceKey === 'string';
  const imageIds = Array.isArray(doc.imageIds) ? (doc.imageIds as string[]) : [];
  const sourceImageUrls = alibabaSourcePreviewUrls(doc.alibabaSourceImageUrls);
  const sourceReview = decodeAlibabaSourceReview(doc.alibabaSourceReview);
  const published = doc.published === true;
  const productPricing = adminCatalogPricingInput(doc);
  const effectiveMoq = effectiveCatalogMoq({ ...productPricing, moq: doc.moq });

  // Only the ids actually rendered (up to the shared catalog image capacity). Memoized on
  // the joined membership so the array reference is stable across renders — the
  // fetch/revoke effect below depends on it directly and must re-run only when
  // the shown set actually changes (e.g. re-opening on a different doc).
  const shownKey = imageIds.slice(0, PRODUCT_IMAGE_MAX_COUNT).join(',');
  const shownIds = useMemo(() => (shownKey ? shownKey.split(',') : []), [shownKey]);

  // Resolve each id through the admin-authenticated preview action into a blob
  // object URL. The public `imageUrl` (`/api/images/:id`) is `publishedRefCount`-
  // gated and 404s every UNPUBLISHED image — but previewing pre-publication is
  // this modal's whole purpose — so we must source bytes the admin way instead.
  const [urls, setUrls] = useState<Record<string, string>>({});
  // Mirror for the unmount cleanup, whose effect deps are [] (would otherwise
  // close over a stale `urls`).
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  // Fetch previews for newly-shown ids and revoke object URLs for ids that left
  // the set. Keyed on the id list so re-opening the modal on a different doc
  // refreshes correctly without leaking the previous doc's blobs.
  useEffect(() => {
    let cancelled = false;
    for (const id of shownIds) {
      if (urlsRef.current[id]) continue;
      getImagePreview(id)
        .then((dataUrl) => fetch(dataUrl))
        .then((res) => res.blob())
        .then((blob) => {
          if (cancelled) return;
          setUrls((m) => (m[id] ? m : { ...m, [id]: URL.createObjectURL(blob) }));
        })
        .catch(() => {
          /* leave unset → "No image"/placeholder; e.g. a still-pending image */
        });
    }
    // Revoke + drop any URL whose id is no longer shown.
    setUrls((m) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [id, url] of Object.entries(m)) {
        if (shownIds.includes(id)) {
          next[id] = url;
        } else {
          URL.revokeObjectURL(url);
          changed = true;
        }
      }
      return changed ? next : m;
    });
    return () => {
      cancelled = true;
    };
  }, [shownIds]);

  // Revoke every remaining object URL on unmount.
  useEffect(
    () => () => {
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
    },
    [],
  );
  const num = (k: string) => (typeof doc[k] === 'number' ? (doc[k] as number) : undefined);

  const priceRows = [['Clearance price', num('clearancePrice')]].filter(
    ([, v]) => v !== undefined,
  ) as [string, number][];

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="product-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto h-[92dvh] max-h-[92dvh] w-[calc(100%-2rem)] max-w-[1440px] overflow-hidden rounded-2xl border-0 bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-5 py-3 sm:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
            <h2 id="product-preview-title" className="text-lg font-semibold text-slate-900">
              Product preview
            </h2>
            {doc.alibabaReviewPending === true && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                New · review needed
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                published ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${published ? 'bg-green-500' : 'bg-slate-400'}`}
              />
              {published ? 'Published' : 'Draft (not public)'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-preview-scroll>
          {sharedPreview ? (
            <Suspense fallback={<output className="block p-8">Loading product preview…</output>}>
              <AdminDetailPreview
                key={doc._id}
                productId={doc._id}
                images={
                  imageIds.length
                    ? shownIds.flatMap((id) => (urls[id] ? [urls[id]] : []))
                    : sourceImageUrls
                }
                sourceImages={imageIds.length === 0 && sourceImageUrls.length > 0}
              />
            </Suspense>
          ) : (
            <div className="grid gap-6 p-5 lg:grid-cols-2">
              {/* Images */}
              <div>
                <div className="aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  {imageIds[0] && urls[imageIds[0]] ? (
                    <img
                      src={urls[imageIds[0]]}
                      alt={String(doc.name ?? '')}
                      className="h-full w-full object-cover"
                    />
                  ) : !imageIds[0] && sourceImageUrls[0] ? (
                    <img
                      src={sourceImageUrls[0]}
                      alt={String(doc.name ?? '')}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-sm text-slate-400">
                      {imageIds[0] ? '…' : 'No image'}
                    </div>
                  )}
                </div>
                {imageIds.length === 0 && sourceImageUrls.length > 0 && (
                  <p className="mt-2 text-xs text-amber-700">
                    Alibaba source preview only. Import or upload an image before publishing.
                  </p>
                )}
                {imageIds.length > 1 && (
                  <div className="mt-3 flex gap-2">
                    {shownIds.slice(1).map((id) =>
                      urls[id] ? (
                        <img
                          key={id}
                          src={urls[id]}
                          alt=""
                          className="h-14 w-14 rounded-lg border border-slate-200 object-cover"
                        />
                      ) : (
                        <span
                          key={id}
                          className="grid h-14 w-14 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-[10px] text-slate-400"
                        >
                          …
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>

              {/* Details */}
              <div>
                {Boolean(doc.category) && (
                  <span className="inline-flex rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                    {String(doc.category)}
                  </span>
                )}
                <h3 className="mt-2 font-display text-xl font-bold text-slate-900">
                  {String(doc.name ?? 'Untitled')}
                </h3>
                {Boolean(doc.description) && (
                  <details className="mt-4 text-sm leading-relaxed text-slate-600">
                    <summary>Product description</summary>
                    <p className="mt-3 whitespace-pre-line">{String(doc.description)}</p>
                  </details>
                )}

                <section
                  aria-label="Effective website pricing"
                  className="mt-4 rounded-xl border border-slate-200 p-4"
                >
                  <h4 className="mb-2 text-sm font-semibold text-slate-900">Website pricing</h4>
                  <EffectiveCatalogPricingBlock product={productPricing} />
                  {effectiveMoq !== undefined && (
                    <p className="mt-2 text-sm">Minimum order quantity: {effectiveMoq}</p>
                  )}
                </section>
                <details className="mt-4 text-sm text-slate-600">
                  <summary>Source information and product facts</summary>
                  <dl className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
                    {sourceReview && (
                      <>
                        <Row
                          label="Alibaba product ID"
                          value={sourceReview.externalProductId || '—'}
                        />
                        <Row
                          label="Source category"
                          value={
                            sourceReview.sourceCategoryName ?? sourceReview.sourceCategoryId ?? '—'
                          }
                        />
                        {sourceReview.modelNumbers.length > 0 && (
                          <Row label="Source model" value={sourceReview.modelNumbers.join(', ')} />
                        )}
                        <Row
                          label="Variants"
                          value={`${sourceReview.variantCount} variants · ${sourceReview.offerCount} offers`}
                        />
                        {sourceReview.minimumOrderQuantity !== undefined && (
                          <Row
                            label="Source MOQ"
                            value={String(sourceReview.minimumOrderQuantity)}
                          />
                        )}
                        <Row
                          label="Source pricing"
                          value={formatAlibabaSourcePricing(sourceReview.primaryPricing)}
                        />
                        <Row label="Source status" value={sourceReview.sourceListingStatus} />
                      </>
                    )}
                    {Boolean(doc.modName) && <Row label="Model" value={String(doc.modName)} />}
                    {Boolean(doc.productCode) && (
                      <Row label="Product code" value={String(doc.productCode)} />
                    )}
                    {num('inventory') !== undefined && (
                      <Row label="Inventory" value={String(num('inventory'))} />
                    )}
                    {priceRows.map(([label, value]) => (
                      <Row key={label} label={label} value={formatPrice(value)} />
                    ))}
                  </dl>
                </details>
              </div>
            </div>
          )}
          {reviewError && (
            <p role="alert" className="px-5 pt-4 text-sm text-red-600">
              {reviewError.message}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-100 bg-white px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
          {canMarkReviewed && doc.alibabaReviewPending === true && onMarkReviewed && (
            <button
              type="button"
              disabled={reviewBusy}
              onClick={onMarkReviewed}
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {reviewBusy ? 'Marking…' : 'Mark reviewed'}
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Edit item
          </button>
        </div>
      </div>
    </dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-800">{value}</dd>
    </div>
  );
}
