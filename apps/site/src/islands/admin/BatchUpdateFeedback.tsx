import type { BatchUpdateResult } from './api.ts';

interface Props {
  result: BatchUpdateResult;
  names: Record<string, string>;
  published?: boolean;
  onDismiss: () => void;
}

export function BatchUpdateFeedback({ result, names, published, onDismiss }: Props) {
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
            Use Edit on the affected products to resolve the listed issues. For Alibaba source
            previews, import the source gallery in Edit and save before publishing. Unconfirmed
            results must be refreshed before retrying; confirmed updates are not rolled back.
          </p>
        </>
      )}
    </section>
  );
}
