import { useState } from 'react';
import { imageUrl, uploadImage } from './api.ts';

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
}

/**
 * Inline image manager used inside the catalog edit form. Uploads files into the
 * `images` byte collection and stores their ids — images are "subjected to" the
 * Headphones / Overstock item rather than managed as a standalone collection.
 */
export function ImageManager({ value, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const ids: string[] = [];
      for (const file of Array.from(files)) {
        ids.push(await uploadImage(file));
      }
      onChange([...value, ...ids]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string) {
    onChange(value.filter((v) => v !== id));
  }

  function move(id: string, dir: -1 | 1) {
    const idx = value.indexOf(id);
    const next = idx + dir;
    if (next < 0 || next >= value.length) return;
    const copy = [...value];
    [copy[idx], copy[next]] = [copy[next] as string, copy[idx] as string];
    onChange(copy);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {value.map((id, i) => (
          <div
            key={id}
            className="group relative h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
          >
            <img src={imageUrl(id)} alt="" className="h-full w-full object-cover" />
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

        <label className="grid h-20 w-20 cursor-pointer place-items-center rounded-lg border-2 border-dashed border-slate-300 text-slate-400 transition hover:border-brand-400 hover:text-brand-600">
          {busy ? (
            <span className="text-[11px]">Uploading…</span>
          ) : (
            <span className="text-2xl leading-none">+</span>
          )}
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        PNG, JPG, SVG, or WebP. The first image is the cover. Drag is replaced by the ‹ › controls.
      </p>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
