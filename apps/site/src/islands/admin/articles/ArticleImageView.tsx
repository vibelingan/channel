import { type NodeViewProps, NodeViewWrapper } from '@tiptap/react';
import { createContext, useContext } from 'react';
import { Select } from '../../../components/form/Select.tsx';
import { useArticleImage, useObjectUrl } from './useArticleMedia.ts';

export const ArticleImageContext = createContext<{
  articleId: string | null;
  disabled: boolean;
  replace: (position: number) => void;
}>({ articleId: null, disabled: true, replace: () => {} });
export function ArticleImageView({ node, updateAttributes, deleteNode, getPos }: NodeViewProps) {
  const context = useContext(ArticleImageContext);
  const image = useArticleImage(context.articleId, String(node.attrs.mediaId));
  const url = useObjectUrl(image.isSuccess && !image.isError ? image.data.blob : undefined);
  return (
    <NodeViewWrapper
      contentEditable={false}
      className="my-4 rounded-lg border border-slate-200 bg-slate-50 p-3"
      data-article-image={String(node.attrs.mediaId)}
    >
      {url && image.data ? (
        <img
          src={url}
          alt={String(node.attrs.alt)}
          width={image.data.width}
          height={image.data.height}
          className={`max-h-80 max-w-full object-contain ${node.attrs.align === 'left' ? 'mr-auto' : node.attrs.align === 'right' ? 'ml-auto' : 'mx-auto'}`}
        />
      ) : (
        <p role={image.isError ? 'alert' : undefined} className="text-sm text-slate-600">
          {image.isError ? 'Image could not be loaded.' : 'Loading private image…'}
        </p>
      )}
      {image.isError && (
        <button type="button" onClick={() => void image.refetch()} className="text-sm underline">
          Retry image
        </button>
      )}
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <label>
          Image description
          <input
            aria-label="Image description"
            disabled={context.disabled}
            maxLength={300}
            value={String(node.attrs.alt)}
            onChange={(event) => updateAttributes({ alt: event.target.value })}
            className="mt-1 w-full rounded border px-2 py-2"
          />
        </label>
        <label>
          Caption
          <input
            aria-label="Image caption"
            disabled={context.disabled}
            maxLength={500}
            value={String(node.attrs.caption)}
            onChange={(event) => updateAttributes({ caption: event.target.value })}
            className="mt-1 w-full rounded border px-2 py-2"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Select
          ariaLabel="Image alignment"
          value={String(node.attrs.align)}
          disabled={context.disabled}
          options={['left', 'center', 'right'].map((value) => ({
            value,
            label: value[0]?.toUpperCase() + value.slice(1),
          }))}
          onChange={(align) => updateAttributes({ align })}
        />
        <button
          type="button"
          disabled={context.disabled}
          onClick={() => {
            const position = getPos();
            if (typeof position === 'number') context.replace(position);
          }}
          className="min-h-10 text-sm underline disabled:opacity-40"
        >
          Replace image
        </button>
        <button
          type="button"
          disabled={context.disabled}
          onClick={deleteNode}
          className="min-h-10 text-sm text-red-700 underline disabled:opacity-40"
        >
          Remove image
        </button>
      </div>
    </NodeViewWrapper>
  );
}
