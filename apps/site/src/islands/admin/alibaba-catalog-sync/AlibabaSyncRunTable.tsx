import type { AlibabaSyncWorkflow } from '@vibelingan-channel/shared';
type History = AlibabaSyncWorkflow['history'];
const labels = {
  'in-progress': 'In progress',
  imported: 'Imported',
  complete: 'Ready for review',
  attention: 'Needs attention',
};
function stamp(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';
}
export function AlibabaSyncRunTable({ history: rows }: { history: History }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h3 className="border-b border-slate-100 px-5 py-4 text-sm font-semibold text-slate-900">
        Recent syncs
      </h3>
      {!rows.length ? (
        <p data-alibaba-runs-empty className="px-5 py-4 text-sm text-slate-500">
          No sync runs yet.
        </p>
      ) : (
        <div data-alibaba-runs className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-slate-500">
                <th className="px-5 py-3 font-medium">Started</th>
                <th className="px-5 py-3 font-medium">Products processed</th>
                <th className="px-5 py-3 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-run-row={row.id}
                  className="border-b border-slate-100 last:border-0"
                >
                  <td className="px-5 py-3 text-slate-600">{stamp(row.startedAt)}</td>
                  <td className="px-5 py-3">{row.processed.toLocaleString('en-US')}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`rounded px-2 py-1 text-xs ${row.result === 'attention' ? 'bg-amber-50 text-amber-800' : row.result === 'complete' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-700'}`}
                    >
                      {labels[row.result]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
