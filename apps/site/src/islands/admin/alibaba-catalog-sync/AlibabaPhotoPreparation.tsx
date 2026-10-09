import type { PhotoPreparationProgress, PhotoPreparationStatus } from './alibaba-api.ts';

interface Props {
  status: PhotoPreparationStatus | null;
  progress: PhotoPreparationProgress | null;
  running: boolean;
  onRun: () => void;
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** Alibaba photos copied into our storage ahead of publishing (PT-G). */
export function AlibabaPhotoPreparation({ status, progress, running, onRun }: Props) {
  const nothingLeft =
    status !== null &&
    status.hiddenDrafts === 0 &&
    status.draftsToFill === 0 &&
    status.draftsMissingPhotos === 0;
  return (
    <section
      data-photo-preparation
      aria-labelledby="alibaba-photo-preparation-title"
      className="rounded-lg border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-3xl">
          <h3
            id="alibaba-photo-preparation-title"
            className="text-base font-semibold text-slate-900"
          >
            Product photos
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Alibaba photos are copied into our storage automatically after each sync, so drafts are
            ready to publish. A new draft appears in Products once its photos are in. Photos an
            admin changed are never replaced.
          </p>
          {status && (
            <p data-photo-preparation-status className="mt-2 text-sm text-slate-800">
              {nothingLeft
                ? 'Every draft has its photos.'
                : `${plural(status.hiddenDrafts, 'new draft', 'new drafts')} being prepared · ${plural(status.draftsToFill, 'draft', 'drafts')} waiting for photos · ${plural(status.draftsMissingPhotos, 'draft', 'drafts')} with photos that could not be copied yet (tried again after a day)`}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={running}
          onClick={onRun}
          className="min-h-11 shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-48"
        >
          {running ? 'Copying photos…' : 'Copy photos now'}
        </button>
      </div>
      {progress && (
        <p
          data-photo-preparation-progress
          aria-live="polite"
          className="mt-3 text-sm text-slate-700"
        >
          {plural(progress.prepared, 'draft ready', 'drafts ready')} ·{' '}
          {plural(progress.photosCopied, 'photo copied', 'photos copied')} ·{' '}
          {progress.photosReused.toLocaleString('en-US')} already copied ·{' '}
          {progress.photosFailed.toLocaleString('en-US')} could not be copied
          {progress.busy > 0
            ? ` · ${plural(progress.busy, 'draft', 'drafts')} changed meanwhile, next pass`
            : ''}
        </p>
      )}
      {progress && progress.failures > 0 && (
        <p data-photo-preparation-failures role="alert" className="mt-2 text-sm text-red-700">
          {plural(progress.failures, 'draft', 'drafts')} could not be saved:{' '}
          {progress.failedProducts.join(', ')}. Open them in Products and save once to fix.
        </p>
      )}
    </section>
  );
}
