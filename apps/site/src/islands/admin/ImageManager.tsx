import { useEffect, useRef, useState } from 'react';
import { getImagePreview, uploadImage } from './api.ts';

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
}

/** A file still uploading, or one that failed and can be retried. Successful
 *  uploads leave this list and their id is committed into `value`. */
interface Pending {
  key: string;
  name: string;
  file: File;
  error?: string;
}

// Matches the server allowlist (catalogImageUploadSchema): SVG/GIF are rejected.
const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Inline image manager for the catalog edit form. Uploads files through the
 * admin-brokered direct-upload flow (`uploadImage`: intent → raw PUT → complete)
 * and stores their ids. Previews come from the admin-authenticated
 * `getImagePreview` (the public `/api/images/:id` is `publishedRefCount`-gated and
 * would 404 unpublished images); just-uploaded files preview from a local object
 * URL so they show instantly without a round-trip.
 */
export function ImageManager({ value, onChange }: Props) {
  const [pending, setPending] = useState<Pending[]>([]);
  // Object URLs for the just-uploaded session; fetched data URLs for persisted ids.
  const [objectUrls, setObjectUrls] = useState<Record<string, string>>({});
  const [fetched, setFetched] = useState<Record<string, string>>({});

  // Latest committed list, so a slow upload appends to the CURRENT value (not the
  // render-time snapshot) — concurrent removes/reorders are preserved.
  const valueRef = useRef(value);
  valueRef.current = value;
  // Mirror of objectUrls for the unmount cleanup (effect deps are [] there).
  const objectUrlsRef = useRef(objectUrls);
  objectUrlsRef.current = objectUrls;

  // Lazily fetch admin previews for persisted ids that have no object URL.
  useEffect(() => {
    let cancelled = false;
    for (const id of value) {
      if (objectUrls[id] || fetched[id]) continue;
      getImagePreview(id)
        .then((url) => {
          if (!cancelled) setFetched((m) => ({ ...m, [id]: url }));
        })
        .catch(() => {
          /* leave unset → placeholder; e.g. a still-pending or removed image */
        });
    }
    return () => {
      cancelled = true;
    };
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
  useEffect(
    () => () => {
      for (const url of Object.values(objectUrlsRef.current)) URL.revokeObjectURL(url);
    },
    [],
  );

  function previewSrc(id: string): string | undefined {
    return objectUrls[id] ?? fetched[id];
  }

  /** Update the latest-value ref and notify the parent together. */
  function commit(next: string[]): void {
    valueRef.current = next;
    onChange(next);
  }

  function failUpload(key: string, e: unknown): void {
    const error = e instanceof Error ? e.message : 'Upload failed';
    setPending((p) => p.map((x) => (x.key === key ? { ...x, error } : x)));
  }

  function succeed(key: string, id: string, file: File): void {
    setObjectUrls((m) => ({ ...m, [id]: URL.createObjectURL(file) }));
    commit([...valueRef.current, id]); // append to the LATEST list, preserving order
    setPending((p) => p.filter((x) => x.key !== key));
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const key = crypto.randomUUID();
      setPending((p) => [...p, { key, name: file.name, file }]);
      try {
        const id = await uploadImage(file);
        succeed(key, id, file);
      } catch (e) {
        failUpload(key, e);
      }
    }
  }

  async function retry(item: Pending): Promise<void> {
    setPending((p) => p.map((x) => (x.key === item.key ? { ...x, error: undefined } : x)));
    try {
      const id = await uploadImage(item.file);
      succeed(item.key, id, item.file);
    } catch (e) {
      failUpload(item.key, e);
    }
  }

  function remove(id: string): void {
    commit(valueRef.current.filter((v) => v !== id));
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

  const uploading = pending.filter((p) => !p.error);
  const failed = pending.filter((p) => p.error);

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {value.map((id, i) => (
          <div
            key={id}
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
            <div className="absolute inset-x-0 bottom-0 flex justify-between bg-slate-900/60 opacity-0 transition group-hover:opacity-100">
              <button
                type="button"
                onClick={() => move(id, -1)}
                className="px-1 text-xs text-white disabled:opacity-30"
                disabled={i === 0}
                aria-label="Move left"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => remove(id)}
                className="px-1 text-xs text-white"
                aria-label="Remove image"
              >
                ✕
              </button>
              <button
                type="button"
                onClick={() => move(id, 1)}
                className="px-1 text-xs text-white disabled:opacity-30"
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
          <button
            key={p.key}
            type="button"
            onClick={() => retry(p)}
            title={p.error}
            className="grid h-20 w-20 place-items-center rounded-lg border-2 border-red-300 bg-red-50 px-1 text-center text-[10px] text-red-600"
          >
            Failed — retry
          </button>
        ))}

        <label className="grid h-20 w-20 cursor-pointer place-items-center rounded-lg border-2 border-dashed border-slate-300 text-slate-400 transition hover:border-brand-400 hover:text-brand-600">
          <span className="text-2xl leading-none">+</span>
          <input
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        JPG, PNG, or WebP. The first image is the cover. Use ‹ › to reorder.
      </p>
    </div>
  );
}
