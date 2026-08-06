/** Run history table (MIU 13) — read-only view over alibabaSyncRuns rows. */
import type { CollectionDoc } from '@vibelingan-channel/shared';

const STATUS_STYLES: Record<string, string> = {
  running: 'bg-blue-50 text-blue-700',
  continuing: 'bg-blue-50 text-blue-700',
  completed: 'bg-emerald-50 text-emerald-700',
  approved: 'bg-emerald-50 text-emerald-700',
  quarantined: 'bg-amber-50 text-amber-800',
  failed: 'bg-red-50 text-red-700',
};

function stamp(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value.slice(0, 16).replace('T', ' ') : '—';
}

export function AlibabaSyncRunTable({ runs }: { runs: CollectionDoc[] }) {
  if (runs.length === 0) {
    return (
      <p
        data-alibaba-runs-empty
        className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-500"
      >
        No sync runs yet.
      </p>
    );
  }
  return (
    <div data-alibaba-runs className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2 font-medium">Run</th>
            <th className="px-4 py-2 font-medium">Mode</th>
            <th className="px-4 py-2 font-medium">Trigger</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Started</th>
            <th className="px-4 py-2 font-medium">Completed</th>
            <th className="px-4 py-2 font-medium">Errors</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const status = String(run.status ?? '');
            return (
              <tr key={run._id} className="border-b border-slate-100" data-run-row={run._id}>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{run._id}</td>
                <td className="px-4 py-2">{String(run.mode ?? '')}</td>
                <td className="px-4 py-2">{String(run.trigger ?? '')}</td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600'}`}
                  >
                    {status}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-600">{stamp(run.startedAt)}</td>
                <td className="px-4 py-2 text-xs text-slate-600">{stamp(run.completedAt)}</td>
                <td className="px-4 py-2 text-xs text-slate-600">
                  {String(run.errorSummary ?? '') || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
