import { type ArticleDocument, renderArticle } from '@vibelingan-channel/articles';
import { useEffect, useId, useState } from 'react';
import { useModalDialog } from '../use-modal-dialog.ts';
import { useArticlePreviewImages } from './useArticleMedia.ts';

type Preview = {
  articleId: string;
  revision: number;
  body: ArticleDocument;
  mediaIds: string[];
  title: string;
};
export function ArticlePreview({
  preview,
  onClose,
  returnFocus,
}: {
  preview: Preview;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const dialogRef = useModalDialog(returnFocus);
  const titleId = useId();
  const images = useArticlePreviewImages(preview);
  const [rendered, setRendered] = useState<{
    source: typeof images.data;
    html: string;
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!images.data || images.isError) {
      setRendered(null);
      return;
    }
    const urls: string[] = [];
    try {
      const media = Object.fromEntries(
        Object.entries(images.data).map(([id, value]) => {
          const url = URL.createObjectURL(value.blob);
          urls.push(url);
          return [
            id,
            {
              kind: 'private-preview',
              url,
              mimeType: value.mimeType,
              width: value.width,
              height: value.height,
            },
          ];
        }),
      );
      const html = renderArticle(preview.body, {
        mode: 'preview',
        media,
        previewOrigin: window.location.origin,
      }).html;
      setRendered({ source: images.data, html, error: '' });
    } catch {
      setRendered({ source: images.data, html: '', error: 'This preview could not be rendered.' });
    }
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [images.data, images.isError, preview.body]);
  const current = rendered?.source === images.data && !images.isError ? rendered : null;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="m-auto max-h-[92dvh] w-[calc(100%-2rem)] max-w-4xl overflow-auto rounded-2xl border-0 bg-white p-0 shadow-xl backdrop:bg-slate-900/60"
    >
      <section aria-label="Draft preview">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
          <h2 id={titleId} className="min-w-0 font-semibold text-slate-900">
            Draft preview · revision {preview.revision}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 shrink-0 rounded-lg px-3 text-sm underline hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Close preview
          </button>
        </header>
        <div className="p-5">
          <h3 className="mb-4 break-words text-2xl font-semibold text-slate-900">
            {preview.title || 'Untitled article'}
          </h3>
          {images.isError || current?.error ? (
            <p role="alert">
              {current?.error || 'Private preview images could not be loaded.'}{' '}
              <button type="button" onClick={() => void images.refetch()} className="underline">
                Retry preview images
              </button>
            </p>
          ) : current ? (
            // The shared renderer accepts only verified same-origin Blob URLs and validated article nodes.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML comes only from the shared strict article renderer.
            <div className="article-body" dangerouslySetInnerHTML={{ __html: current.html }} />
          ) : (
            <output>Loading private preview…</output>
          )}
        </div>
      </section>
    </dialog>
  );
}
