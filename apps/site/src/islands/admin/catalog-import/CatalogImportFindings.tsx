/**
 * Findings for one staged product, grouped so the operator sees the shape of
 * the problem rather than 40 near-identical lines.
 */
import type { FindingView } from './catalog-import-api.ts';

export function CatalogImportFindings({ findings }: { findings: readonly FindingView[] }) {
  if (findings.length === 0) return null;

  const grouped = new Map<string, FindingView[]>();
  for (const finding of findings) {
    grouped.set(finding.code, [...(grouped.get(finding.code) ?? []), finding]);
  }

  return (
    <ul className="mt-2 space-y-1 text-xs" data-testid="item-findings">
      {[...grouped.entries()].map(([code, entries]) => {
        const first = entries[0];
        if (first === undefined) return null;
        const isError = entries.some((entry) => entry.severity === 'error');
        return (
          <li
            key={code}
            className={`rounded px-2 py-1 ${
              isError ? 'bg-rose-50 text-rose-900' : 'bg-amber-50 text-amber-900'
            }`}
          >
            <span className="font-mono font-semibold">{code}</span>
            {entries.length > 1 ? <span> ×{entries.length}</span> : null}
            <span> — {first.message}</span>
            {first.rowNumber !== null ? (
              <span className="text-slate-500"> (row {first.rowNumber})</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
