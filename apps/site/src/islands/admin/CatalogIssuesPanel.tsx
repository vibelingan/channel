import {
  type CatalogIssue,
  CatalogIssueSchema,
  catalogIssueMessage,
} from '@vibelingan-channel/shared/catalog-issues';

const remedies = {
  edit: 'Edit the saved product, then retry.',
  classify: 'Assign a website category before publishing.',
  'retry-media': 'Check the product photos in Edit, then retry.',
  retry: 'Retry when the current change finishes.',
  resync: 'Use Alibaba Sync to refresh this source product.',
  'review-change': 'Reload and review the current product before trying again.',
  'system-repair': 'This data needs a system repair. Keep the issue details for support.',
  reload: 'Reload the current product and permissions, then retry.',
  'sign-in': 'Sign in again, then retry.',
} satisfies Record<CatalogIssue['remedy'], string>;

/** Does not require a valid website DTO, so a broken draft keeps its repair actions. */
export function CatalogIssuesPanel({
  message,
  issues,
  onRetry,
  onEdit,
}: {
  message: string;
  issues: readonly unknown[];
  onRetry: () => void;
  onEdit: () => void;
}) {
  const checked = issues.slice(0, 50).flatMap((issue) => {
    const parsed = CatalogIssueSchema.safeParse(issue);
    return parsed.success ? [parsed.data] : [];
  });
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800"
    >
      <p>{message}</p>
      {checked.length > 0 && (
        <ul
          aria-label="Product data issues"
          className="mt-4 max-h-80 list-disc space-y-4 overflow-y-auto pl-5"
        >
          {checked.map((issue, index) => (
            <li key={`${index}:${issue.path}`}>
              <p>{catalogIssueMessage(issue)}</p>
              {issue.observed?.chars !== undefined && issue.expected?.maxChars !== undefined && (
                <p>
                  Length: {issue.observed.chars}; limit: {issue.expected.maxChars}.
                </p>
              )}
              {issue.observed?.count !== undefined && issue.expected?.maxCount !== undefined && (
                <p>
                  Items: {issue.observed.count}; limit: {issue.expected.maxCount}.
                </p>
              )}
              <p>{remedies[issue.remedy]}</p>
              <details className="mt-1 text-xs">
                <summary className="min-h-11 cursor-pointer py-3 underline">
                  Show issue details
                </summary>
                <code className="break-all">
                  {issue.code} · {issue.path}
                </code>
              </details>
            </li>
          ))}
        </ul>
      )}
      {issues.length > 50 && <p className="mt-2">Only the first 50 issue entries are shown.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <button type="button" className="min-h-11 underline" onClick={onRetry}>
          Retry product preview
        </button>
        <button type="button" className="min-h-11 underline" onClick={onEdit}>
          Open item to repair
        </button>
        {checked.some((issue) => issue.remedy === 'sign-in') && (
          <a
            className="inline-flex min-h-11 items-center underline"
            href="/login?returnTo=%2Fadmin"
          >
            Sign in again
          </a>
        )}
      </div>
    </div>
  );
}
