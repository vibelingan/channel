import type { ArticleDraft } from '@vibelingan-channel/articles/drafts';
import {
  type ArticleReleaseControl,
  type ArticleReleaseRequest,
  articleReleaseActive,
} from '@vibelingan-channel/articles/release';
import { useRef, useState } from 'react';
import { AdminApiError } from '../api.ts';
import { useArticleDraft } from './useArticleDrafts.ts';
import { useArticlePublication } from './useArticlePublication.ts';

type Command = ArticleReleaseRequest | ArticleReleaseControl;
export function ArticlePublication({
  saved,
  locked,
  save,
  onBusy,
}: {
  saved: ArticleDraft | null;
  locked: boolean;
  save: () => Promise<ArticleDraft | null>;
  onBusy: (value: boolean) => void;
}) {
  const { capability, task, write } = useArticlePublication(saved?.id ?? null);
  const currentDraft = useArticleDraft(saved?.id ?? null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Command | null>(null);
  const busy = useRef(false);
  if (capability.data !== true)
    return capability.isError ? (
      <output className="text-sm text-amber-900">
        Publishing availability could not be checked.{' '}
        <button type="button" onClick={() => void capability.refetch()} className="underline">
          Check again
        </button>
      </output>
    ) : null;
  const latest = task.data;
  const active = !!latest && articleReleaseActive(latest.state);
  const published = currentDraft.data ? currentDraft.data.published : saved?.published;
  const disabled =
    locked || write.isPending || !!pending || active || (!!saved && task.isPending) || task.isError;
  async function send(command: Command) {
    if (busy.current) return;
    busy.current = true;
    onBusy(true);
    setError('');
    setPending(command);
    try {
      await write.mutateAsync(command);
      setPending(null);
    } catch (failure) {
      if (
        failure instanceof AdminApiError &&
        ['CONFLICT', 'VALIDATION_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'].includes(
          failure.code,
        )
      ) {
        setPending(null);
        setError(failure.message);
        void task.refetch();
      } else
        setError(
          'The request could not be confirmed. Retry the same request or check its status; your draft is still here.',
        );
    } finally {
      busy.current = false;
      onBusy(false);
    }
  }
  async function publish() {
    if (busy.current || disabled) return;
    busy.current = true;
    onBusy(true);
    setError('');
    let draft: ArticleDraft | null;
    try {
      draft = await save();
    } finally {
      busy.current = false;
      onBusy(false);
    }
    if (draft)
      await send({
        operation: 'publish',
        articleId: draft.id,
        expectedRevision: draft.revision,
        requestId: crypto.randomUUID(),
      });
  }
  const status = latest
    ? {
        QUEUED: 'Publication requested. Waiting to publish.',
        BUILDING: 'Building and checking pages. The current website is unchanged.',
        DEPLOYING: 'Uploading and checking the live pages.',
        SUCCEEDED:
          latest.operation === 'withdraw'
            ? 'Article withdrawn. The draft and images are kept.'
            : `Published · revision ${latest.revision}`,
        FAILED:
          latest.error === 'CANCELLED'
            ? 'Request cancelled. The current website is unchanged.'
            : latest.error === 'DELIVERY_STOPPED'
              ? 'Delivery stopped before upload. The current website is unchanged.'
              : latest.error === 'RESTORED'
                ? 'Publication failed. The previous website was restored and checked.'
                : 'Build failed before upload. The current website is unchanged.',
        UNKNOWN:
          'Delivery needs a technical check. Further publication is paused to protect the current website.',
      }[latest.state]
    : published
      ? `Published · revision ${published.revision}`
      : 'This article is a private draft.';
  return (
    <section
      aria-label="Publication"
      className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Publication</h2>
          <output className="mt-1 text-sm text-slate-600">{status}</output>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void publish()}
            className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {published ? 'Save and publish update' : 'Save and publish'}
          </button>
          {published && (
            <button
              type="button"
              disabled={disabled || !saved}
              onClick={() => {
                if (
                  saved &&
                  window.confirm(
                    'Withdraw this article from the public website? The draft and images will be kept.',
                  )
                )
                  void send({
                    operation: 'withdraw',
                    articleId: saved.id,
                    expectedRevision: saved.revision,
                    requestId: crypto.randomUUID(),
                  });
              }}
              className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40"
            >
              Withdraw article
            </button>
          )}
          {latest?.state === 'FAILED' && !pending && (
            <button
              type="button"
              disabled={locked || write.isPending}
              onClick={() =>
                void send({
                  operation: 'retry',
                  articleId: latest.articleId,
                  taskId: latest.id,
                  requestId: crypto.randomUUID(),
                })
              }
              className="min-h-11 px-2 text-sm font-semibold underline disabled:opacity-40"
            >
              Retry revision {latest.revision}
            </button>
          )}
          {latest?.state === 'QUEUED' && (
            <button
              type="button"
              disabled={locked || write.isPending}
              onClick={() =>
                void send({
                  operation: 'cancel',
                  articleId: latest.articleId,
                  taskId: latest.id,
                  requestId: crypto.randomUUID(),
                })
              }
              className="min-h-11 px-2 text-sm underline disabled:opacity-40"
            >
              Cancel request
            </button>
          )}
        </div>
      </div>
      {active && (
        <p className="text-xs text-slate-500">
          You can keep editing the next draft. This request uses saved revision {latest.revision}.
        </p>
      )}
      {(task.isError || error) && (
        <p role="alert" className="text-sm text-amber-900">
          {error || 'Publication status could not be loaded.'}{' '}
          <button
            type="button"
            disabled={write.isPending}
            onClick={() => void task.refetch()}
            className="underline"
          >
            Check status
          </button>
        </p>
      )}
      {pending && (
        <button
          type="button"
          disabled={write.isPending || locked}
          onClick={() => void send(pending)}
          className="min-h-11 text-sm font-semibold underline"
        >
          Retry the same request
        </button>
      )}
    </section>
  );
}
