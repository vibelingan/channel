import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { getImagePreview, uploadImage } from './api.ts';

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  maxItems?: number;
  inputId?: string;
}

/** A file still uploading, or one that failed and can be retried. Successful
 *  uploads leave this list and their id is committed into `value`. */
export interface PendingUpload {
  key: string;
  name: string;
  file: File;
  attemptId: string;
  status: 'uploading' | 'failed';
  error?: string;
}

// Matches the server allowlist (catalogImageUploadSchema): SVG/GIF are rejected.
const ACCEPT = 'image/jpeg,image/png,image/webp';

export function availableImageSlots(
  maxItems: number | undefined,
  committedCount: number,
  pendingCount: number,
): number {
  if (maxItems === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(maxItems) || maxItems < 0) return 0;
  return Math.max(0, maxItems - committedCount - pendingCount);
}

export function boundedSelectedFiles(files: readonly File[], availableSlots: number): File[] {
  return Number.isFinite(availableSlots) ? files.slice(0, availableSlots) : [...files];
}

export function claimRetryAttempt(
  pending: readonly PendingUpload[],
  key: string,
  attemptId: string,
): { pending: PendingUpload[]; claimed?: PendingUpload } {
  let claimed: PendingUpload | undefined;
  const next = pending.map((item) => {
    if (item.key !== key || item.status !== 'failed') return item;
    claimed = {
      key: item.key,
      name: item.name,
      file: item.file,
      attemptId,
      status: 'uploading',
    };
    return claimed;
  });
  return claimed ? { pending: next, claimed } : { pending: [...pending] };
}

export function settlePendingAttempt(
  pending: readonly PendingUpload[],
  key: string,
  attemptId: string,
): { pending: PendingUpload[]; accepted: boolean } {
  const accepted = pending.some(
    (item) => item.key === key && item.attemptId === attemptId && item.status === 'uploading',
  );
  return {
    pending: accepted ? pending.filter((item) => item.key !== key) : [...pending],
    accepted,
  };
}

export function failPendingAttempt(
  pending: readonly PendingUpload[],
  key: string,
  attemptId: string,
  error: string,
): PendingUpload[] {
  return pending.map((item) =>
    item.key === key && item.attemptId === attemptId && item.status === 'uploading'
      ? { ...item, status: 'failed', error }
      : item,
  );
}

/**
 * Inline image manager for the catalog edit form. Uploads files through the
 * admin-brokered direct-upload flow (`uploadImage`: intent → direct COS POST → complete)
 * and stores their ids. Previews come from the admin-authenticated
 * `getImagePreview` (the public `/api/images/:id` is `publishedRefCount`-gated and
 * would 404 unpublished images); just-uploaded files preview from a local object
 * URL so they show instantly without a round-trip.
 */
export function ImageManager({ value, onChange, maxItems, inputId = 'imageIds' }: Props) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [selectionNotice, setSelectionNotice] = useState('');
  // Object URLs for the just-uploaded session; fetched data URLs for persisted ids.
  const [objectUrls, setObjectUrls] = useState<Record<string, string>>({});
  const [fetched, setFetched] = useState<Record<string, string>>({});

  // Latest committed list, so a slow upload appends to the CURRENT value (not the
  // render-time snapshot) — concurrent removes/reorders are preserved.
  const valueRef = useRef(value);
  valueRef.current = value;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const requestedPreviewsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  // Mirror of objectUrls for the unmount cleanup (effect deps are [] there).
  const objectUrlsRef = useRef(objectUrls);
  objectUrlsRef.current = objectUrls;

  // Lazily fetch admin previews for persisted ids that have no object URL.
  useEffect(() => {
    for (const id of value) {
      if (objectUrls[id] || fetched[id] || requestedPreviewsRef.current.has(id)) continue;
      requestedPreviewsRef.current.add(id);
      getImagePreview(id)
        .then((url) => {
          if (mountedRef.current && valueRef.current.includes(id)) {
            setFetched((current) => ({ ...current, [id]: url }));
          }
        })
        .catch(() => {
          requestedPreviewsRef.current.delete(id);
          /* leave unset → placeholder; e.g. a still-pending or removed image */
        });
    }
  }, [value, objectUrls, fetched]);

  // Revoke an object URL once its id leaves `value`, and all on unmount — a long
  // editing session with large images would otherwise leak blob memory.
  useEffect(() => {
    setObjectUrls((m) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [id, url] of Object.entries(m)) {
        if (value.includes(id)) {
          next[id] = url;
        } else {
          URL.revokeObjectURL(url);
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, [value]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of Object.values(objectUrlsRef.current)) URL.revokeObjectURL(url);
    };
  }, []);

  function previewSrc(id: string): string | undefined {
    return objectUrls[id] ?? fetched[id];
  }

  function commitPending(update: (current: PendingUpload[]) => PendingUpload[]): void {
    const next = update(pendingRef.current);
    pendingRef.current = next;
    setPending(next);
  }

  /** Update the latest-value ref and notify the parent together. */
  function commit(next: string[]): void {
    valueRef.current = next;
    onChange(next);
  }

  function failUpload(key: string, attemptId: string, e: unknown): void {
    const error = e instanceof Error ? e.message : 'Upload failed';
    commitPending((current) => failPendingAttempt(current, key, attemptId, error));
  }

  function succeed(key: string, attemptId: string, id: string, file: File): void {
    const settled = settlePendingAttempt(pendingRef.current, key, attemptId);
    if (!settled.accepted) return;
    commitPending(() => settled.pending);
    setObjectUrls((m) => ({ ...m, [id]: URL.createObjectURL(file) }));
    commit([...valueRef.current, id]); // append to the LATEST list, preserving order
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const selected = boundedSelectedFiles(
      Array.from(files),
      availableImageSlots(maxItems, valueRef.current.length, pendingRef.current.length),
    );
    const omittedCount = files.length - selected.length;
    setSelectionNotice(
      omittedCount > 0
        ? `${omittedCount} file${omittedCount === 1 ? '' : 's'} not selected. Remove an image to add more.`
        : '',
    );
    const admitted = selected.map((file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      file,
      attemptId: crypto.randomUUID(),
      status: 'uploading' as const,
    }));
    commitPending((current) => [...current, ...admitted]);
    for (const item of admitted) {
      try {
        const id = await uploadImage(item.file);
        succeed(item.key, item.attemptId, id, item.file);
      } catch (e) {
        failUpload(item.key, item.attemptId, e);
      }
    }
  }

  async function retry(item: PendingUpload): Promise<void> {
    const attemptId = crypto.randomUUID();
    const retryClaim = claimRetryAttempt(pendingRef.current, item.key, attemptId);
    if (!retryClaim.claimed) return;
    commitPending(() => retryClaim.pending);
    try {
      const id = await uploadImage(item.file);
      succeed(item.key, attemptId, id, item.file);
    } catch (e) {
      failUpload(item.key, attemptId, e);
    }
  }

  function discardFailed(key: string): void {
    commitPending((current) =>
      current.filter((item) => item.key !== key || item.status !== 'failed'),
    );
    setSelectionNotice('Failed upload removed. You can select a replacement image.');
  }

  function remove(id: string): void {
    const current = valueRef.current;
    const index = current.indexOf(id);
    const next = current.filter((valueId) => valueId !== id);
    const nextId = next[Math.min(Math.max(index, 0), next.length - 1)];
    const selector = nextId
      ? `[data-image-id="${CSS.escape(nextId)}"] [data-image-remove]`
      : `#${CSS.escape(inputId)}`;
    requestedPreviewsRef.current.delete(id);
    setSelectionNotice('Image removed. You can select a replacement image.');
    flushSync(() => commit(next));
    document.querySelector<HTMLElement>(selector)?.focus();
  }

  function move(id: string, dir: -1 | 1): void {
    const current = valueRef.current;
    const idx = current.indexOf(id);
    const next = idx + dir;
    if (next < 0 || next >= current.length) return;
    const copy = [...current];
    [copy[idx], copy[next]] = [copy[next] as string, copy[idx] as string];
    commit(copy);
  }

  const uploading = pending.filter((item) => item.status === 'uploading');
  const failed = pending.filter((item) => item.status === 'failed');
  const availableSlots = availableImageSlots(maxItems, value.length, pending.length);
  const capacityText =
    maxItems === undefined
      ? ''
      : value.length + pending.length >= maxItems
        ? `${value.length + pending.length} of ${maxItems} images. Remove an image to add another.`
        : `${value.length + pending.length} of ${maxItems} images.`;
  const failureNotice =
    failed.length === 0
      ? ''
      : `${failed.length} upload${failed.length === 1 ? '' : 's'} failed. Retry or remove ${failed.length === 1 ? 'it' : 'them'}.`;
  const liveNotice = [capacityText, selectionNotice, failureNotice].filter(Boolean).join(' ');

  return (
    <div data-image-manager>
      <div className="flex flex-wrap gap-3">
        {value.map((id, i) => (
          <div
            key={id}
            data-image-id={id}
            className="group relative h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
          >
            {previewSrc(id) ? (
              <img src={previewSrc(id)} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="grid h-full w-full place-items-center text-[10px] text-slate-400">
                …
              </span>
            )}
            {i === 0 && (
              <span className="absolute left-1 top-1 rounded bg-slate-900/80 px-1 py-0.5 text-[9px] font-semibold text-white">
                Cover
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex justify-between bg-slate-900/60 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => move(id, -1)}
                className="px-1 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30"
                disabled={i === 0}
                aria-label="Move left"
              >
                ‹
              </button>
              <button
                type="button"
                data-image-remove
                onClick={() => remove(id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  remove(id);
                }}
                className="px-1 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                aria-label="Remove image"
              >
                ✕
              </button>
              <button
                type="button"
                onClick={() => move(id, 1)}
                className="px-1 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30"
                disabled={i === value.length - 1}
                aria-label="Move right"
              >
                ›
              </button>
            </div>
          </div>
        ))}

        {uploading.map((p) => (
          <div
            key={p.key}
            className="grid h-20 w-20 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-[11px] text-slate-400"
          >
            Uploading…
          </div>
        ))}

        {failed.map((p) => (
          <div
            key={p.key}
            title={p.error}
            className="grid h-20 w-20 place-items-center rounded-lg border-2 border-red-300 bg-red-50 px-1 text-center text-[10px] text-red-600"
          >
            <span>Upload failed</span>
            <span className="flex gap-1">
              <button type="button" onClick={() => retry(p)} className="underline">
                Retry
              </button>
              <button type="button" onClick={() => discardFailed(p.key)} className="underline">
                Remove
              </button>
            </span>
          </div>
        ))}

        <label
          htmlFor={inputId}
          className={`grid h-20 w-20 place-items-center rounded-lg border-2 border-dashed transition focus-within:ring-2 focus-within:ring-brand-600 focus-within:ring-offset-2 ${
            availableSlots > 0
              ? 'cursor-pointer border-slate-300 text-slate-400 hover:border-brand-400 hover:text-brand-600'
              : 'cursor-not-allowed border-slate-200 text-slate-300'
          }`}
        >
          <span className="text-2xl leading-none" aria-hidden="true">
            +
          </span>
          <span className="sr-only">Add product images</span>
          <input
            id={inputId}
            type="file"
            accept={ACCEPT}
            multiple
            disabled={availableSlots <= 0}
            className="sr-only"
            aria-label="Add product images"
            aria-describedby={`${inputId}-capacity`}
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <p id={`${inputId}-capacity`} className="mt-2 text-xs text-slate-400">
        JPG, PNG, or WebP. The first image is the cover. Use ‹ › to reorder.
        {capacityText ? ` ${capacityText}` : ''}
      </p>
      <output className="mt-1 block text-xs text-amber-700" aria-live="polite">
        {liveNotice}
      </output>
    </div>
  );
}
