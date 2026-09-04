import { useState } from 'react';
import type { DraftMaterializationProgress } from './alibaba-api.ts';

interface Props {
  connected: boolean;
  busy: boolean;
  progress: DraftMaterializationProgress | null;
  onMaterialize: (sourceCategoryId?: string) => void;
}

export function AlibabaDraftMaterialization({ connected, busy, progress, onMaterialize }: Props) {
  const [sourceCategoryId, setSourceCategoryId] = useState('');
  return (
    <section
      data-draft-materialization
      aria-labelledby="alibaba-draft-materialization-title"
      className="rounded-lg border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-3xl">
          <h3
            id="alibaba-draft-materialization-title"
            className="text-base font-semibold text-slate-900"
          >
            Make synced products visible
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Creates or repairs one admin-visible product draft for every active Alibaba source
            product. Drafts remain unpublished; unmapped categories stay uncategorized until an
            operator assigns a product family.
          </p>
        </div>
        <div className="w-full shrink-0 sm:w-64">
          <label className="text-xs font-medium text-slate-600" htmlFor="draft-source-category-id">
            Source category ID (optional)
          </label>
          <input
            id="draft-source-category-id"
            value={sourceCategoryId}
            disabled={!connected || busy}
            onChange={(event) => setSourceCategoryId(event.currentTarget.value)}
            maxLength={128}
            className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            placeholder="All active products"
          />
          <button
            type="button"
            disabled={!connected || busy}
            onClick={() => onMaterialize(sourceCategoryId.trim() || undefined)}
            className="mt-2 min-h-11 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Create missing drafts'}
          </button>
        </div>
      </div>
      {progress && (
        <p
          data-draft-materialization-progress
          aria-live="polite"
          className="mt-3 text-sm text-slate-700"
        >
          Checked {progress.visited.toLocaleString('en-US')} · created{' '}
          {progress.created.toLocaleString('en-US')} · already present{' '}
          {progress.existing.toLocaleString('en-US')} · failed{' '}
          {progress.failures.toLocaleString('en-US')}
        </p>
      )}
    </section>
  );
}
