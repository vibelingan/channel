/**
 * Quarantine review (MIU 13): quarantined runs with their frozen candidate
 * hash and an explicit approve action. Approval is rejected server-side when
 * a newer run superseded the candidate (hash recomputation, R1 E4).
 */
import type { CollectionDoc } from '@vibelingan-channel/shared';

export interface AlibabaQuarantineReviewProps {
  runs: CollectionDoc[];
  busy: boolean;
  onApprove: (runId: string, candidateHash: string) => void;
}

export function AlibabaQuarantineReview({ runs, busy, onApprove }: AlibabaQuarantineReviewProps) {
  if (runs.length === 0) return null;
  return (
    <div data-alibaba-quarantine className="rounded-lg border border-amber-200 bg-amber-50 p-5">
      <h3 className="text-base font-semibold text-amber-900">Quarantined runs</h3>
      <p className="mt-1 text-xs text-amber-800">
        These runs exceeded a safety threshold and made NO product changes. Review the reasons, then
        approve to promote the frozen candidate set.
      </p>
      <ul className="mt-3 space-y-2">
        {runs.map((run) => (
          <li
            key={run._id}
            data-quarantined-run={run._id}
            className="flex items-center justify-between gap-4 rounded-md bg-white px-3 py-2"
          >
            <div className="min-w-0">
              <p className="font-mono text-xs text-slate-700">{run._id}</p>
              <p className="mt-0.5 text-xs text-amber-800">
                {Array.isArray(run.alerts) ? (run.alerts as string[]).join(', ') : ''}
              </p>
            </div>
            <button
              type="button"
              data-approve-run={run._id}
              disabled={busy || typeof run.candidateHash !== 'string' || run.candidateHash === ''}
              onClick={() => onApprove(String(run._id), String(run.candidateHash ?? ''))}
              className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Approve candidate
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
