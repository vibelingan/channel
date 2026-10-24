import { type ArticleDocument, renderArticle } from '@vibelingan-channel/articles';
import { useEffect, useState } from 'react';
import { useArticlePreviewImages } from './useArticleMedia.ts';

type Preview = {
  articleId: string;
  revision: number;
  body: ArticleDocument;
  mediaIds: string[];
  title: string;
};
export function ArticlePreview({ preview, onClose }: { preview: Preview; onClose: () => void }) {
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
    <section aria-label="Draft preview" className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Draft preview · revision {preview.revision}</h2>
        <button type="button" onClick={onClose} className="text-sm underline">
          Close preview
        </button>
      </div>
      <h3 className="mb-4 text-2xl font-semibold">{preview.title || 'Untitled article'}</h3>
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
    </section>
  );
}
