/**
 * Catalog Import preview.
 *
 * Read-only by design in this branch: importing and publishing are driven by
 * the local CLI, which keeps the operator surface to "look at what the file
 * would do" before anything reaches the catalog. The page rides the existing
 * generic admin API — both collections it reads are registered `readOnly` —
 * so it introduces no new server action and no new authorization path.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Select } from '../../../components/form/Select.tsx';
import { CatalogImportProductTable } from './CatalogImportProductTable.tsx';
import { CatalogImportSummary } from './CatalogImportSummary.tsx';
import { fetchImportItems, fetchImportJobs } from './catalog-import-api.ts';

type ItemFilter = 'all' | 'problems';

export function CatalogImportPage() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ItemFilter>('all');

  const jobs = useQuery({ queryKey: ['catalogImportJobs'], queryFn: () => fetchImportJobs(25) });
  const activeJobId = selectedJobId ?? jobs.data?.[0]?.id ?? null;
  const activeJob = jobs.data?.find((job) => job.id === activeJobId) ?? null;

  const items = useQuery({
    queryKey: ['catalogImportItems', activeJobId],
    queryFn: () => fetchImportItems(activeJobId as string),
    enabled: activeJobId !== null,
  });

  if (jobs.isLoading) return <p className="text-sm text-slate-500">Loading catalog imports…</p>;
  if (jobs.isError) {
    return (
      <p className="text-sm text-rose-700">
        Could not load catalog imports: {(jobs.error as Error).message}
      </p>
    );
  }
  if ((jobs.data?.length ?? 0) === 0) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="font-display text-xl font-semibold text-ink">Catalog Import</h1>
        <p className="text-sm text-slate-600">
          No imports yet. Run one locally against a source workbook:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
          {`LOCAL_DB_FILE=./data/db.dianxiaomi-spike.json \\
LOCAL_MEDIA_DIR=./data/media-dianxiaomi-spike \\
pnpm --filter @vibelingan-channel/local-server import:dianxiaomi -- \\
  --file "/absolute/path/to/export.xlsx"`}
        </pre>
      </div>
    );
  }

  const staged = items.data?.products ?? [];
  const visible =
    filter === 'problems'
      ? staged.filter((item) => item.status === 'rejected' || item.findings.length > 0)
      : staged;

  return (
    <div className="space-y-6">
      <h1 className="font-display text-xl font-semibold text-ink">Catalog Import</h1>

      <Select
        label="Import job"
        className="max-w-xl"
        value={activeJobId ?? ''}
        options={(jobs.data ?? []).map((job) => ({
          value: job.id,
          label: `${job.sourceFileName} · ${job.status} · ${job.startedAt.slice(0, 19).replace('T', ' ')}`,
        }))}
        onChange={setSelectedJobId}
      />

      {activeJob ? <CatalogImportSummary job={activeJob} /> : null}

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">Show</span>
        {(['all', 'problems'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              filter === option ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-700'
            }`}
          >
            {option === 'all' ? 'All products' : 'Rejected and warnings'}
          </button>
        ))}
      </div>

      {items.isLoading ? (
        <p className="text-sm text-slate-500">Loading staged products…</p>
      ) : items.isError ? (
        <p className="text-sm text-rose-700">
          Could not load staged products: {(items.error as Error).message}
        </p>
      ) : (
        <>
          {items.data?.truncated === true ? (
            <p className="text-sm text-slate-600">
              Showing the first {staged.length} of {items.data.total} staged products.
            </p>
          ) : null}
          <CatalogImportProductTable products={visible} />
        </>
      )}
    </div>
  );
}
