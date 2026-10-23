import { type ArticleContent, parseArticleContent } from '@vibelingan-channel/articles';
import type { ArticleDraft } from '@vibelingan-channel/articles/drafts';
import {
  ARTICLE_IMAGE_MAX_BYTES,
  ARTICLE_IMAGE_MIMES,
  type ArticleMediaView,
} from '@vibelingan-channel/articles/media';
import { useEffect, useRef, useState } from 'react';
import { AdminApiError } from '../api.ts';
import { ArticleEditor } from './ArticleEditor.tsx';
import { ArticlePreview } from './ArticlePreview.tsx';
import { type DraftWrite, getArticleDraft } from './article-api.ts';
import { useArticlePreview, useWriteArticle } from './useArticleDrafts.ts';
import { useUploadArticleImage } from './useArticleMedia.ts';

export const emptyArticle = (): ArticleContent =>
  parseArticleContent({
    title: '',
    slug: '',
    body: { schemaVersion: 1, document: { type: 'doc', content: [{ type: 'paragraph' }] } },
  });
const fieldClass = 'mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';

export function ArticleForm({
  initial,
  onBack,
  onGuardChange,
}: {
  initial: ArticleDraft | null;
  onBack: () => void;
  onGuardChange: (guard: (() => boolean) | null) => void;
}) {
  const [saved, setSaved] = useState(initial);
  const [content, setContent] = useState<ArticleContent>(() => initial?.content ?? emptyArticle());
  const baseline = useRef(JSON.stringify(initial?.content ?? emptyArticle()));
  const [pending, setPending] = useState<DraftWrite | null>(null);
  const createId = useRef(crypto.randomUUID());
  const write = useWriteArticle();
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState<Parameters<typeof ArticlePreview>[0]['preview'] | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const imageWrite = useUploadArticleImage();
  const uploadController = useRef<AbortController | null>(null);
  const uploadRetry = useRef<{ file: File; requestId: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      uploadController.current?.abort();
    };
  }, []);
  const previewRequest = useArticlePreview();
  const previewing = previewRequest.isPending;
  const [valid, setValid] = useState(true);
  const dirty = JSON.stringify(content) !== baseline.current;
  const locked = write.isPending || previewing || uploading || pending !== null;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty || locked;
  useEffect(() => {
    const guard = () =>
      !dirtyRef.current ||
      window.confirm('Leave this article? Unsaved changes or an unconfirmed save may be lost.');
    onGuardChange(guard);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      onGuardChange(null);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [onGuardChange]);

  function accept(next: ArticleDraft) {
    setSaved(next);
    setContent(next.content);
    baseline.current = JSON.stringify(next.content);
    setPending(null);
    return next;
  }
  async function save(): Promise<ArticleDraft | null> {
    if (!valid || write.isPending || conflict) return null;
    if (!dirty && saved && !pending) return saved;
    const input: DraftWrite =
      pending ??
      (saved
        ? { operation: 'save', articleId: saved.id, expectedRevision: saved.revision, content }
        : { operation: 'create', requestId: createId.current, content });
    setPending(input);
    setError('');
    setPreview(null);
    try {
      const next = await write.mutateAsync(input);
      return accept(next);
    } catch (error) {
      if (
        pending &&
        input.operation === 'save' &&
        error instanceof AdminApiError &&
        error.code === 'CONFLICT'
      ) {
        try {
          const current = await getArticleDraft(input.articleId, AbortSignal.timeout(30000));
          if (
            current.revision === input.expectedRevision + 1 &&
            JSON.stringify(current.content) === JSON.stringify(parseArticleContent(input.content))
          )
            return accept(current);
        } catch {
          /* An unreadable current revision cannot confirm a previous write. */
        }
      }
      if (error instanceof AdminApiError && error.code === 'CONFLICT') {
        setConflict(true);
        setPending(null);
        setError(
          `Another save changed this article${error.currentRevision ? ` to revision ${error.currentRevision}` : ''}. Your text is still here. Copy it before reloading.`,
        );
      } else if (
        error instanceof AdminApiError &&
        ['VALIDATION_ERROR', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)
      ) {
        setPending(null);
        setError(error.message);
      } else
        setError(
          'The save could not be confirmed. Retry the same save before continuing; your text is still here.',
        );
      return null;
    }
  }
  async function showPreview() {
    const draft = await save();
    if (!draft) return;
    setError('');
    try {
      const result = await previewRequest.mutateAsync({
        articleId: draft.id,
        revision: draft.revision,
      });
      setPreview({ ...result, title: draft.content.title });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Preview could not be loaded.');
    }
  }
  async function uploadImage(file: File): Promise<ArticleMediaView | null> {
    if (uploadController.current || conflict || pending || !valid) return null;
    if (
      !ARTICLE_IMAGE_MIMES.some((mime) => mime === file.type) ||
      file.size < 1 ||
      file.size > ARTICLE_IMAGE_MAX_BYTES
    ) {
      setError('Choose a JPEG, PNG or WebP image up to 3 MiB.');
      return null;
    }
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    setError('');
    setPreview(null);
    try {
      const draft = await save();
      if (!draft || !alive.current) return null;
      const requestId =
        uploadRetry.current?.file === file ? uploadRetry.current.requestId : crypto.randomUUID();
      uploadRetry.current = { file, requestId };
      const result = await imageWrite.mutateAsync({
        articleId: draft.id,
        file,
        requestId,
        signal: controller.signal,
      });
      uploadRetry.current = null;
      return alive.current ? result : null;
    } catch (error) {
      if (alive.current)
        setError(
          error instanceof Error ? error.message : 'Image upload failed. Retry the same file.',
        );
      return null;
    } finally {
      uploadController.current = null;
      if (alive.current) setUploading(false);
    }
  }
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          disabled={write.isPending || previewing || uploading}
          onClick={onBack}
          className="min-h-11 text-sm text-slate-600"
        >
          ← Articles
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <output aria-live="polite" className="text-sm text-slate-500">
            {uploading
              ? 'Uploading and verifying image…'
              : write.isPending
                ? 'Saving…'
                : pending
                  ? 'Save not confirmed'
                  : dirty
                    ? 'Unsaved changes'
                    : saved
                      ? `Saved · revision ${saved.revision}`
                      : 'New draft'}
          </output>
          <button
            type="button"
            disabled={locked || conflict || !valid}
            onClick={() => void showPreview()}
            className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40"
          >
            {previewing ? 'Loading preview…' : 'Preview'}
          </button>
          <button
            type="button"
            disabled={
              write.isPending ||
              previewing ||
              uploading ||
              conflict ||
              !valid ||
              (!dirty && !!saved && !pending)
            }
            onClick={() => void save()}
            className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {pending && !write.isPending ? 'Retry save' : 'Save draft'}
          </button>
        </div>
      </div>
      <h1 className="text-xl font-semibold text-slate-900">
        {saved ? 'Edit article' : 'New article'}
      </h1>
      {initial && saved && initial.revision > saved.revision && !conflict && (
        <output className="block rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
          A newer saved version is available. Your current input is preserved; return to Articles
          and reopen to load it.
        </output>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
        >
          {error}
          {conflict && (
            <button type="button" className="ml-3 underline" onClick={onBack}>
              Back to articles
            </button>
          )}
        </div>
      )}
      <fieldset disabled={locked} className="space-y-5 disabled:opacity-70">
        <label className="block text-sm font-medium text-slate-700">
          Title
          <input
            aria-label="Title"
            maxLength={200}
            value={content.title}
            onChange={(event) => {
              setContent({ ...content, title: event.target.value });
              setPreview(null);
            }}
            className={fieldClass}
          />
        </label>
        <ArticleEditor
          articleId={saved?.id ?? null}
          onUploadImage={uploadImage}
          onValidityChange={setValid}
          initial={initial?.content.body ?? emptyArticle().body}
          disabled={locked}
          onChange={(body) => {
            setContent((current) => ({ ...current, body }));
            setValid(true);
            setPreview(null);
          }}
        />
        <details className="rounded-lg border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">
            Article details and search settings
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(['authorName', 'slug', 'excerpt', 'seoTitle', 'seoDescription'] as const).map(
              (field) => (
                <label
                  key={field}
                  className={`block text-sm text-slate-700 ${field === 'excerpt' || field === 'seoDescription' ? 'sm:col-span-2' : ''}`}
                >
                  {
                    {
                      authorName: 'Author',
                      slug: 'URL slug',
                      excerpt: 'Summary',
                      seoTitle: 'Search title',
                      seoDescription: 'Search description',
                    }[field]
                  }
                  <input
                    aria-label={field}
                    maxLength={
                      {
                        authorName: 120,
                        slug: 120,
                        excerpt: 500,
                        seoTitle: 200,
                        seoDescription: 320,
                      }[field]
                    }
                    value={content[field]}
                    onChange={(event) => {
                      setContent({ ...content, [field]: event.target.value });
                      setPreview(null);
                    }}
                    className={fieldClass}
                  />
                </label>
              ),
            )}
          </div>
        </details>
      </fieldset>
      <p className="text-xs text-slate-500">
        Drafts and images are private. Saving does not publish an article. Removing an image from
        the article keeps its stored file.
      </p>
      {preview && (
        <ArticlePreview
          key={`${preview.articleId}:${preview.revision}`}
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
