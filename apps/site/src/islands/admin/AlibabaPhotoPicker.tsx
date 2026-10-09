import { PreviewImageContent } from './ImageViewer.tsx';

export interface AlibabaPhotoSource {
  url: string;
  /** Our copy, when the photo was already copied into our storage. */
  imageId: string | null;
}

interface Props {
  title: string;
  /** Every Alibaba photo in Alibaba's order; null while loading. */
  sources: readonly AlibabaPhotoSource[] | null;
  currentIds: readonly string[];
  limit: number;
  /** The photo being copied right now. */
  busyUrl: string | null;
  onAdd: (source: AlibabaPhotoSource) => void;
}

/**
 * Alibaba's photos next to the website's: which are on the website, and an
 * Add button for the others (owner 2026-10-09: listings with more photos than
 * the website shows get the first ones automatically; the rest can be added).
 */
export function AlibabaPhotoPicker({ title, sources, currentIds, limit, busyUrl, onAdd }: Props) {
  if (!sources || sources.length === 0) return null;
  const full = currentIds.length >= limit;
  const noun = title.replace(/^Alibaba /, '');
  return (
    <div data-alibaba-photo-picker className="mt-3 space-y-2">
      <p className="text-xs font-semibold text-slate-700">{title}</p>
      {sources.length > limit && (
        <p className="text-xs text-slate-600">
          Alibaba has {sources.length} {noun}; up to {limit} can be on the website. The first ones
          were added; add any other below.
        </p>
      )}
      {full && sources.some((source) => !onWebsite(source, currentIds)) && (
        <p className="text-xs text-amber-800">
          All {limit} places are taken. Remove a photo to add another.
        </p>
      )}
      <ul className="flex flex-wrap gap-2">
        {sources.map((source, index) => {
          const added = onWebsite(source, currentIds);
          return (
            <li key={source.url} className="w-20 text-center">
              <div className="h-16 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                <PreviewImageContent
                  src={source.url}
                  alt=""
                  className="h-full w-full object-contain"
                />
              </div>
              {added ? (
                <p className="mt-1 text-[11px] leading-4 text-green-800">On the website</p>
              ) : (
                <button
                  type="button"
                  disabled={full || busyUrl !== null}
                  onClick={() => onAdd(source)}
                  aria-label={`Add ${title.replace(/s$/, '')} ${index + 1}`}
                  className="mt-1 min-h-8 w-full rounded border border-slate-300 bg-white text-xs font-medium text-brand-700 disabled:opacity-50"
                >
                  {busyUrl === source.url ? 'Adding…' : 'Add'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function onWebsite(source: AlibabaPhotoSource, currentIds: readonly string[]) {
  return source.imageId !== null && currentIds.includes(source.imageId);
}
