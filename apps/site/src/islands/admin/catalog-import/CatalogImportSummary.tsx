/**
 * Job header: what was read, what came out, and what is still undecided.
 *
 * The pricing notice is not decoration. Every price on this page is CNY from
 * the merchant's shop feed, and the same admin shows USD prices on ordinary
 * products — so the page says which is which, in words, above the numbers.
 */
import type { JobView } from './catalog-import-api.ts';

const COUNT_LABELS: readonly [string, string][] = [
  ['rows', 'Source rows'],
  ['parentSkus', 'Product families'],
  ['skus', 'Distinct SKUs'],
  ['storeProducts', 'Store listings'],
  ['storeVariants', 'Store SKU lines'],
  ['stores', 'Stores'],
  ['uniqueImageUrls', 'Unique image URLs'],
];

const SUMMARY_LABELS: readonly [string, string][] = [
  ['products', 'Product candidates'],
  ['variants', 'Variant candidates'],
  ['quarantined', 'Quarantined'],
  ['errors', 'Errors'],
  ['warnings', 'Warnings'],
  ['inventoryKnown', 'Exact inventory'],
  ['inventoryConflict', 'Conflicting inventory'],
  ['inventoryUnknown', 'Unknown inventory'],
];

function Stat({ label, value, alarm }: { label: string; value: number; alarm?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        alarm && value > 0 ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-semibold text-ink tabular-nums">{value}</dd>
    </div>
  );
}

export function CatalogImportSummary({ job }: { job: JobView }) {
  return (
    <section className="space-y-4" data-testid="import-summary">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-lg font-semibold text-ink">{job.sourceFileName}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            job.status === 'failed'
              ? 'bg-rose-100 text-rose-800'
              : job.status === 'applied'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-slate-100 text-slate-700'
          }`}
        >
          {job.status}
        </span>
        <span className="text-xs text-slate-500">
          {job.provider} · {job.templateId || 'unknown template'} · sheet {job.sheetName || '—'}
        </span>
      </header>

      <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <strong>Prices on this page are source CNY.</strong> USD website prices are not calculated
        or published yet — the margin basis, which source price to use, the exchange-rate source and
        the rounding rule are all still to be decided.
      </p>

      {job.errorSummary !== '' ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {job.errorSummary}
        </p>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">What the file contained</h3>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {COUNT_LABELS.map(([key, label]) => (
            <Stat key={key} label={label} value={job.counts[key] ?? 0} />
          ))}
        </dl>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">What it produced</h3>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {SUMMARY_LABELS.map(([key, label]) => (
            <Stat
              key={key}
              label={label}
              value={job.summary[key] ?? 0}
              alarm={key === 'errors' || key === 'quarantined' || key === 'inventoryConflict'}
            />
          ))}
        </dl>
      </div>

      {job.ignoredHeaders.length > 0 ? (
        <p className="text-sm text-slate-600">
          <strong>Columns not recognised:</strong> {job.ignoredHeaders.join(', ')}. They were
          ignored, not rejected — add them to the header alias table if they matter.
        </p>
      ) : null}

      <p className="text-xs text-slate-400">
        Source digest {job.sourceFileSha256.slice(0, 16)}… ·{' '}
        {job.sourceEvidenceStatus === 'retained'
          ? 'the exact workbook is retained as private source evidence.'
          : job.sourceEvidenceStatus === 'absent'
            ? 'the exact workbook is not available; the digest is retained for diagnosis.'
            : 'workbook retention could not be confirmed; the digest is retained for diagnosis.'}
      </p>
    </section>
  );
}
