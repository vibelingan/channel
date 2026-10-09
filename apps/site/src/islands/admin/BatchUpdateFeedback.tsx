import type { BatchUpdateResult } from './api.ts';

interface Props {
  result: BatchUpdateResult;
  names: Record<string, string>;
  published?: boolean;
  /** Ids left out of a batch Publish because their Alibaba changes need review (DEC-19). */
  skipped?: readonly string[];
  onDismiss: () => void;
}

export function BatchUpdateFeedback({ result, names, published, skipped = [], onDismiss }: Props) {
  const hasFailures = result.failures.length > 0;
  return (
    <section
      role={hasFailures ? 'alert' : 'status'}
      className={`mt-4 rounded-xl border p-4 text-sm ${hasFailures ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-green-200 bg-green-50 text-green-900'}`}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="font-semibold">
          {result.updated}{' '}
          {published === true ? 'published' : published === false ? 'disabled' : 'updated'}
          {hasFailures ? ` · ${result.failures.length} need attention` : ''}
        </p>
        <button type="button" className="shrink-0 underline" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {skipped.length > 0 && (
        <p className="mt-2">
          Skipped (Alibaba changes to review): {skipped.map((id) => names[id] || id).join(', ')}.
          Open each in Edit to review its changes.
        </p>
      )}
      {hasFailures && (
        <>
          <ul className="mt-2 space-y-2">
            {result.failures.map((failure) => (
              <li key={failure.id}>
                <strong>{names[failure.id] || failure.id}</strong>
                {': '}
                {failure.outcome === 'unconfirmed' ? 'Not confirmed — ' : ''}
                {failure.message}
              </li>
            ))}
          </ul>
          <p className="mt-3">
            Fix the reason listed for each product (in Edit when it asks for it), then publish it
            again. Unconfirmed results must be refreshed before retrying; confirmed updates are not
            rolled back.
          </p>
        </>
      )}
    </section>
  );
}
