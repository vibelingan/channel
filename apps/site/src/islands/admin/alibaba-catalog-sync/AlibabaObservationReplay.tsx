import type { ProductDetailPriceMode, SourceObservationReplayPlan } from './alibaba-api.ts';

export interface AlibabaObservationReplayProps {
  connected: boolean;
  busy: boolean;
  phase: 'idle' | 'validating' | 'validated' | 'applying' | 'applied' | 'failed';
  progress: string | null;
  plan: SourceObservationReplayPlan | null;
  applied: number | null;
  onValidate: () => void;
  onApply: () => void;
}

const PRICE_MODE_ORDER: ProductDetailPriceMode[] = [
  'fixed',
  'range',
  'tiered',
  'negotiable',
  'unavailable',
];

function priceModeSummary(plan: SourceObservationReplayPlan): string {
  const parts = PRICE_MODE_ORDER.flatMap((mode) =>
    plan.priceModes[mode] ? [`${mode} ${plan.priceModes[mode]}`] : [],
  );
  return parts.join(' · ') || 'none';
}

export function AlibabaObservationReplay({
  connected,
  busy,
  phase,
  progress,
  plan,
  applied,
  onValidate,
  onApply,
}: AlibabaObservationReplayProps) {
  const canApply = connected && !busy && phase === 'validated' && plan?.ready === true;
  return (
    <section
      data-observation-replay
      aria-labelledby="alibaba-observation-replay-title"
      className="rounded-lg border border-slate-200 bg-white p-5"
    >
      <div className="max-w-3xl">
        <h3
          id="alibaba-observation-replay-title"
          className="text-base font-semibold text-slate-900"
        >
          Build common catalog data
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Re-parses private Alibaba raw evidence into the shared source schema. Validation reads
          every item first; apply is enabled only when every page matches its raw hash and current
          offer set. Canonical products and links are never changed.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          data-replay-validate
          disabled={!connected || busy}
          onClick={onValidate}
          className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === 'validating' ? 'Validating…' : 'Validate all raw evidence'}
        </button>
        <button
          type="button"
          data-replay-apply
          disabled={!canApply}
          onClick={onApply}
          className="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === 'applying' ? 'Applying…' : 'Apply validated data'}
        </button>
      </div>

      {!connected && (
        <p className="mt-2 text-xs text-amber-700">Connect the Alibaba account before replaying.</p>
      )}
      {progress && (
        <p data-replay-progress aria-live="polite" className="mt-3 text-sm text-slate-600">
          {progress}
        </p>
      )}

      {plan && (
        <div data-replay-summary className="mt-4 border-t border-slate-200 pt-4">
          <p
            className={`text-sm font-semibold ${plan.ready ? 'text-emerald-700' : 'text-red-700'}`}
          >
            {plan.ready
              ? `Validation passed for ${plan.counts.sourceProducts.toLocaleString('en-US')} source products.`
              : 'Validation stopped because at least one source product failed.'}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-500">Pages</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{plan.pages.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Variants</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {plan.counts.variants.toLocaleString('en-US')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Attributed variants</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {plan.counts.attributedVariants.toLocaleString('en-US')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Warnings</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {plan.counts.warnings.toLocaleString('en-US')}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-slate-600">Prices: {priceModeSummary(plan)}</p>
          {applied !== null && (
            <p data-replay-applied className="mt-2 text-sm font-semibold text-emerald-700">
              Applied {applied.toLocaleString('en-US')} common observations.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
