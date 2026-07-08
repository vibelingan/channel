import type { CollectionDoc } from '@vibelingan-channel/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPrice } from '../shop/api.ts';
import { getImagePreview } from './api.ts';

interface Props {
  doc: CollectionDoc;
  onClose: () => void;
  onEdit: () => void;
}

/**
 * Catalog item preview — shows admins/contributors how a Headphones or Overstock
 * item will look to the public before they publish it.
 */
export function PreviewModal({ doc, onClose, onEdit }: Props) {
  const imageIds = Array.isArray(doc.imageIds) ? (doc.imageIds as string[]) : [];
  const published = doc.published === true;

  // Only the ids actually rendered (cover + up to four thumbnails). Memoized on
  // the joined membership so the array reference is stable across renders — the
  // fetch/revoke effect below depends on it directly and must re-run only when
  // the shown set actually changes (e.g. re-opening on a different doc).
  const shownKey = imageIds.slice(0, 5).join(',');
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

  const priceRows = [
    ['Unit price', num('unitPrice')],
    ['Clearance price', num('clearancePrice')],
    ['Wholesale price', num('wholesalePrice')],
    ['VIP price', num('vipPrice')],
  ].filter(([, v]) => v !== undefined) as [string, number][];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 p-5">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Preview</h2>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                published ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${published ? 'bg-green-500' : 'bg-slate-400'}`}
              />
              {published ? 'Published' : 'Disabled (not public)'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100"
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

        <div className="grid gap-6 p-5 sm:grid-cols-2">
          {/* Images */}
          <div>
            <div className="aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              {imageIds[0] && urls[imageIds[0]] ? (
                <img
                  src={urls[imageIds[0]]}
                  alt={String(doc.name ?? '')}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-slate-400">
                  {imageIds[0] ? '…' : 'No image'}
                </div>
              )}
            </div>
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
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                {String(doc.description)}
              </p>
            )}

            <dl className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
              {Boolean(doc.modName) && <Row label="Model" value={String(doc.modName)} />}
              {Boolean(doc.productCode) && (
                <Row label="Product code" value={String(doc.productCode)} />
              )}
              {num('moq') !== undefined && <Row label="MOQ" value={String(num('moq'))} />}
              {num('inventory') !== undefined && (
                <Row label="Inventory" value={String(num('inventory'))} />
              )}
              {priceRows.map(([label, value]) => (
                <Row key={label} label={label} value={formatPrice(value)} />
              ))}
            </dl>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 p-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Edit item
          </button>
        </div>
      </div>
    </div>
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
