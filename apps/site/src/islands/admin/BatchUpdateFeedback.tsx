import type { BatchUpdateResult } from './api.ts';

interface Props {
  result: BatchUpdateResult;
  names: Record<string, string>;
  published?: boolean;
  /** Ids left out of a batch Publish because their Alibaba changes need review (DEC-19). */
  skipped?: readonly string[];
  /** Sends the products that need no fix again; the button shows only when given. */
  onRetry?: (ids: string[]) => void;
  retrying?: boolean;
  /** Other work, such as status read-back, must finish before retry can accept a click. */
  retryDisabled?: boolean;
  onDismiss: () => void;
}

/** Products worth sending again as they are: nothing has to be fixed first. */
export function retryableIds(result: BatchUpdateResult): string[] {
  return result.failures.filter((failure) => failure.retryable).map((failure) => failure.id);
}

export function BatchUpdateFeedback({
  result,
  names,
  published,
  skipped = [],
  onRetry,
  retrying = false,
  retryDisabled = false,
  onDismiss,
}: Props) {
  const hasFailures = result.failures.length > 0;
  const done = published === true ? 'published' : published === false ? 'disabled' : 'updated';
  const unclear = result.failures.filter((failure) => failure.outcome === 'unconfirmed').length;
  const notDone = result.failures.length - unclear;
  const needsFix = result.failures.some((failure) => !failure.retryable);
  const retry = retryableIds(result);
  const summary = [
    `${result.updated} ${done}`,
    notDone ? `${notDone} not ${done}` : '',
    unclear ? `${unclear} couldn't be checked` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section
      role={hasFailures ? 'alert' : 'status'}
      className={`mt-4 rounded-xl border p-4 text-sm ${hasFailures ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-green-200 bg-green-50 text-green-900'}`}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="font-semibold">{summary}</p>
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
                <strong>{names[failure.id] || failure.id}</strong>: {failure.message}
              </li>
            ))}
          </ul>
          {needsFix && (
            <p className="mt-3">
              Fix the reason shown for each product (in Edit), then{' '}
              {published === true ? 'publish' : 'try'} it again.
            </p>
          )}
          {onRetry && retry.length > 0 && (
            <button
              type="button"
              disabled={retrying || retryDisabled}
              className="mt-3 min-h-11 rounded-lg border border-amber-400 bg-white px-4 font-semibold disabled:opacity-50"
              onClick={() => onRetry(retry)}
            >
              {retrying
                ? 'Trying again…'
                : `Try again for ${retry.length} ${retry.length === 1 ? 'product' : 'products'}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
