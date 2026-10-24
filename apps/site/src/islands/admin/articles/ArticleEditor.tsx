import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { type ArticleDocument, fromTiptapJSON, toTiptapJSON } from '@vibelingan-channel/articles';
import { safeArticleHref } from '@vibelingan-channel/articles/document';
import {
  ARTICLE_IMAGE_MAX_COUNT,
  type ArticleMediaView,
  articleImageIds,
} from '@vibelingan-channel/articles/media';
import { useEffect, useRef, useState } from 'react';
import { Select } from '../../../components/form/Select.tsx';
import { ArticleImageContext } from './ArticleImageView.tsx';
import { articleExtensions } from './editor-extensions.ts';

export function ArticleEditor({
  initial,
  onChange,
  disabled,
  onValidityChange,
  articleId,
  onUploadImage,
}: {
  articleId: string | null;
  onUploadImage: (file: File) => Promise<ArticleMediaView | null>;
  onValidityChange: (valid: boolean) => void;
  initial: ArticleDocument;
  onChange: (document: ArticleDocument) => void;
  disabled: boolean;
}) {
  const [error, setError] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const target = useRef<number | null>(null);
  const pendingFile = useRef<File | null>(null);
  const [uploadError, setUploadError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function upload(file: File) {
    if (
      target.current === null &&
      editor &&
      articleImageIds(fromTiptapJSON(editor.getJSON())).length >= ARTICLE_IMAGE_MAX_COUNT
    ) {
      setUploadError(
        'An article supports at most 20 different images. Remove one before adding another.',
      );
      return;
    }
    pendingFile.current = file;
    setUploadError('');
    const result = await onUploadImage(file);
    if (!mounted.current) return;
    if (!result) {
      setUploadError(
        'Image upload was not confirmed. Retry the same file, or choose another image.',
      );
      return;
    }
    if (target.current !== null) {
      const node = editor?.state.doc.nodeAt(target.current);
      if (node?.type.name !== 'articleImage') {
        setUploadError('The image selection changed. Choose its replacement again.');
        return;
      }
      editor
        ?.chain()
        .command(({ tr }) => {
          tr.setNodeMarkup(target.current ?? 0, undefined, {
            ...node.attrs,
            mediaId: result.mediaId,
          });
          return true;
        })
        .run();
    } else
      editor
        ?.chain()
        .focus()
        .insertContent({
          type: 'articleImage',
          attrs: {
            mediaId: result.mediaId,
            alt: file.name.slice(0, 300),
            caption: '',
            align: 'center',
          },
        })
        .run();
    pendingFile.current = null;
  }
  const editor = useEditor({
    extensions: articleExtensions(),
    content: toTiptapJSON(initial),
    immediatelyRender: false,
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': 'Article body',
        'aria-multiline': 'true',
        class: 'article-body min-h-80 px-5 py-4 outline-none',
      },
    },
    onUpdate: ({ editor }) => {
      try {
        onChange(fromTiptapJSON(editor.getJSON()));
        setError('');
        onValidityChange(true);
      } catch {
        onValidityChange(false);
        setError('This formatting is unsupported. Undo it before saving.');
      }
    },
  });
  const selection = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive('bold'),
            italic: editor.isActive('italic'),
            underline: editor.isActive('underline'),
            bullet: editor.isActive('bulletList'),
            ordered: editor.isActive('orderedList'),
            table: editor.isActive('table'),
            heading: editor.isActive('heading')
              ? String(editor.getAttributes('heading').level)
              : 'paragraph',
          }
        : null,
  });
  // The owning form freezes all inputs during an unresolved write.
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  const button = (name: string, action: () => void, active = false) => (
    <button
      key={name}
      type="button"
      disabled={!editor || disabled}
      aria-label={name}
      aria-pressed={active}
      onClick={action}
      className={`min-h-10 rounded px-2 text-sm disabled:opacity-40 ${active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
    >
      {name}
    </button>
  );
  return (
    <div className="rounded-lg border border-slate-300 bg-white">
      <div
        className="flex flex-wrap items-center gap-1 border-b border-slate-200 p-2"
        aria-label="Text formatting"
      >
        {button('Bold', () => editor?.chain().focus().toggleBold().run(), selection?.bold)}
        {button('Italic', () => editor?.chain().focus().toggleItalic().run(), selection?.italic)}
        {button(
          'Underline',
          () => editor?.chain().focus().toggleUnderline().run(),
          selection?.underline,
        )}
        <Select
          ariaLabel="Paragraph style"
          disabled={!editor || disabled}
          className="w-40"
          placeholder=""
          value={selection?.heading ?? 'paragraph'}
          options={[
            { value: 'paragraph', label: 'Paragraph' },
            { value: '2', label: 'Heading 2' },
            { value: '3', label: 'Heading 3' },
            { value: '4', label: 'Heading 4' },
          ]}
          onChange={(value) => {
            if (value === 'paragraph') editor?.chain().focus().setParagraph().run();
            else if (value === '2' || value === '3' || value === '4')
              editor
                ?.chain()
                .focus()
                .setHeading({ level: Number(value) as 2 | 3 | 4 })
                .run();
          }}
        />
        {button(
          'Bullets',
          () => editor?.chain().focus().toggleBulletList().run(),
          selection?.bullet,
        )}
        {button(
          'Numbered',
          () => editor?.chain().focus().toggleOrderedList().run(),
          selection?.ordered,
        )}
        {button('Link', () => setLink(editor?.getAttributes('link').href || ''))}
        {button('Image', () => {
          target.current = null;
          fileInput.current?.click();
        })}
        {button('Table', () =>
          editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        )}
        {selection?.table && (
          <>
            {button('Add row', () => editor?.chain().focus().addRowAfter().run())}
            {button('Add column', () => editor?.chain().focus().addColumnAfter().run())}
            {button('Delete table', () => editor?.chain().focus().deleteTable().run())}
          </>
        )}
        {button('Undo', () => editor?.chain().focus().undo().run())}
        {button('Redo', () => editor?.chain().focus().redo().run())}
        <details className="text-sm">
          <summary className="cursor-pointer rounded px-2 py-2 text-slate-700">
            More formatting
          </summary>
          <div className="flex flex-wrap gap-1">
            {' '}
            {button('Strike', () => editor?.chain().focus().toggleStrike().run())}{' '}
            {button('Quote', () => editor?.chain().focus().toggleBlockquote().run())}{' '}
            {button('Code', () => editor?.chain().focus().toggleCode().run())}{' '}
            {button('Code block', () => editor?.chain().focus().toggleCodeBlock().run())}{' '}
            {button('Left', () => editor?.chain().focus().setTextAlign('left').run())}{' '}
            {button('Center', () => editor?.chain().focus().setTextAlign('center').run())}{' '}
            {button('Right', () => editor?.chain().focus().setTextAlign('right').run())}{' '}
            {button('Divider', () => editor?.chain().focus().setHorizontalRule().run())}
          </div>
        </details>
      </div>
      {link !== null && (
        <div className="flex flex-wrap gap-2 border-b p-3">
          <label className="flex-1 text-sm">
            Link URL
            <input
              aria-label="Link URL"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              className="ml-2 rounded border px-2 py-1"
            />
          </label>
          <button
            type="button"
            className="text-sm font-semibold"
            onClick={() => {
              if (link && !safeArticleHref(link)) {
                setError('Use an HTTPS URL, a site path, or an anchor.');
                return;
              }
              if (link)
                editor?.chain().focus().extendMarkRange('link').setLink({ href: link }).run();
              else editor?.chain().focus().extendMarkRange('link').unsetLink().run();
              setLink(null);
              setError('');
            }}
          >
            Apply link
          </button>
          <button type="button" onClick={() => setLink(null)}>
            Cancel
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="Upload article image"
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
      {uploadError && (
        <p role="alert" className="px-3 py-2 text-sm text-red-700">
          {uploadError}{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (pendingFile.current) void upload(pendingFile.current);
            }}
            className="underline"
          >
            Retry upload
          </button>
        </p>
      )}
      <ArticleImageContext.Provider
        value={{
          articleId,
          disabled,
          replace: (position) => {
            target.current = position;
            fileInput.current?.click();
          },
        }}
      >
        <EditorContent editor={editor} />
      </ArticleImageContext.Provider>
      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
