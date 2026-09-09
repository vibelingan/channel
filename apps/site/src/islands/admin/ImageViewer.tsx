import { useId, useState } from 'react';
import { useModalDialog } from './use-modal-dialog.ts';

export interface PreviewImage {
  id: string;
  src?: string;
  label: string;
}

/** Callers supply only authenticated preview bytes or allowlisted supplier images. */
export function PreviewImageContent({
  src,
  alt,
  className = '',
}: {
  src?: string;
  alt: string;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!src || failedSrc === src) {
    return (
      <span className="grid h-full w-full place-items-center p-2 text-center text-xs text-slate-500">
        Image unavailable
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
      className={className}
    />
  );
}

export function ImageViewer({
  images,
  initialId,
  onClose,
}: {
  images: readonly PreviewImage[];
  initialId: string;
  onClose: () => void;
}) {
  const dialogRef = useModalDialog();
  const titleId = useId();
  const [selectedId, setSelectedId] = useState(initialId);
  const index = Math.max(
    0,
    images.findIndex((image) => image.id === selectedId),
  );
  const current = images[index];
  const move = (direction: -1 | 1) => {
    const next = images[index + direction];
    if (next) setSelectedId(next.id);
  };
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-4xl max-h-[92dvh] overflow-auto rounded-2xl border-0 bg-white p-0 shadow-xl backdrop:bg-slate-900/60"
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3">
        <h2 id={titleId} className="font-semibold text-slate-900">
          Image preview
        </h2>
        <button
          type="button"
          aria-label="Close image preview"
          onClick={onClose}
          className="min-h-11 min-w-11 rounded-lg text-xl text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          ×
        </button>
      </header>
      <div className="grid h-[min(58dvh,560px)] place-items-center bg-slate-50 p-4">
        <PreviewImageContent
          key={current?.id}
          src={current?.src}
          alt={current?.label ?? 'Product image'}
          className="h-full max-h-[54dvh] w-full object-contain"
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => move(-1)}
          className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Previous image
        </button>
        <output className="text-center text-sm text-slate-600">
          {images.length ? index + 1 : 0} / {images.length}
        </output>
        <button
          type="button"
          disabled={index >= images.length - 1}
          onClick={() => move(1)}
          className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Next image
        </button>
      </div>
    </dialog>
  );
}
