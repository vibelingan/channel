import { useEffect, useState } from 'react';
import { Select } from '../../components/form/Select.tsx';
import { EffectiveCatalogPricingBlock } from '../shop/EffectiveCatalogPricingBlock.tsx';
import { effectiveCatalogMoq, effectiveCatalogPricing } from '../shop/catalog-pricing.ts';
import { AlibabaSourceQuote } from './AlibabaSourceQuote.tsx';
import { QuantityTierPricingEditor } from './QuantityTierPricingEditor.tsx';
import { adminSourceMoqFallback, adminSourcePricingFallback } from './alibaba-source-review.ts';
import { adminCatalogPricingInput, manualPricingSeed } from './product-pricing-editor.ts';

interface Props {
  initial?: Record<string, unknown>;
  state: Record<string, string | boolean>;
  error?: string;
  onChange: (patch: Record<string, string | boolean>) => void;
  onValidityChange: (invalid: boolean) => void;
}

export function ProductPricingEditor({
  initial = {},
  state,
  error,
  onChange,
  onValidityChange,
}: Props) {
  const [tierInvalid, setTierInvalid] = useState(false);
  let tiers: unknown;
  try {
    tiers = state.manualCatalogPricing ? JSON.parse(String(state.manualCatalogPricing)) : undefined;
  } catch {
    tiers = null;
  }
  const number = (value: unknown) =>
    typeof value === 'string' && value.trim() ? Number(value) : undefined;
  const pricingDoc = {
    ...initial,
    catalogPricingMode: state.catalogPricingMode,
    manualCatalogPricing: tiers,
    wholesalePrice: number(state.wholesalePrice),
    unitPrice: number(state.unitPrice),
  };
  const input = adminCatalogPricingInput(pricingDoc);
  const sourceFallback = adminSourcePricingFallback(pricingDoc);
  const decision = effectiveCatalogPricing(input);
  const linked =
    typeof initial.alibabaPrimarySourceKey === 'string' &&
    initial.alibabaPrimarySourceKey.trim() !== '';
  const manual =
    state.catalogPricingMode === 'manual' ||
    (state.catalogPricingMode !== 'source' && decision.source !== 'alibaba');
  const explicitManual = state.catalogPricingMode === 'manual';
  const invalid =
    manual && (tierInvalid || (explicitManual && decision.source === 'quote-required'));
  useEffect(() => {
    onValidityChange(invalid);
  }, [invalid, onValidityChange]);
  const moq =
    effectiveCatalogMoq({ ...input, moq: number(state.moq) }) ?? adminSourceMoqFallback(pricingDoc);

  function changeMode(mode: string) {
    if (mode === 'source') {
      setTierInvalid(false);
      onChange({ catalogPricingMode: 'source' });
      return;
    }
    const seed = manualPricingSeed(input);
    onChange({
      catalogPricingMode: 'manual',
      ...(seed ? { manualCatalogPricing: JSON.stringify(seed) } : {}),
    });
  }

  return (
    <div className="space-y-4" aria-label="Website pricing settings">
      {linked && (
        <div>
          <Select
            id="catalogPricingMode"
            label="Website pricing"
            required
            value={manual ? 'manual' : 'source'}
            options={[
              { value: 'source', label: 'Follow Alibaba pricing' },
              { value: 'manual', label: 'Manual website pricing' },
            ]}
            onChange={changeMode}
          />
          <p className="mt-2 text-xs text-slate-600">
            Manual prices take priority. Following Alibaba again keeps your manual settings for
            later; it does not delete them.
          </p>
        </div>
      )}
      <section
        aria-label="Effective website pricing"
        className="rounded-lg border border-slate-200 bg-slate-50 p-3"
      >
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Website price preview</h3>
        <p className="mb-2 text-xs text-slate-600">
          Based on the current form values. Unsaved changes are not live.
        </p>
        {sourceFallback ? (
          <AlibabaSourceQuote value={sourceFallback} />
        ) : (
          <>
            <EffectiveCatalogPricingBlock product={input} />
            {moq !== undefined && <p className="mt-2 text-sm">Minimum order quantity: {moq}</p>}
          </>
        )}
      </section>
      {manual && (
        <>
          <QuantityTierPricingEditor
            value={String(state.manualCatalogPricing || '')}
            error={error}
            onValidityChange={setTierInvalid}
            onChange={(value) => {
              // Normalizing the JSON presentation on mount is not an admin intervention.
              if (value === JSON.stringify(tiers) || (!value && tiers === undefined)) return;
              onChange({ manualCatalogPricing: value, catalogPricingMode: 'manual' });
            }}
          />
          {!state.manualCatalogPricing && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600">
                Use quantity tiers above, or one website unit price below. A missing price is not
                zero.
              </p>
              <label className="block text-sm font-medium text-slate-700">
                Website unit price (USD)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={String(state.wholesalePrice || state.unitPrice || '')}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  onChange={(event) =>
                    onChange({
                      wholesalePrice: event.target.value,
                      unitPrice: event.target.value,
                      catalogPricingMode: 'manual',
                    })
                  }
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Minimum order quantity
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={String(state.moq || '')}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  onChange={(event) => onChange({ moq: event.target.value })}
                />
              </label>
            </div>
          )}
          {invalid && (
            <p role="alert" className="text-sm text-red-700">
              Enter a valid manual price before saving, or choose Follow Alibaba pricing.
            </p>
          )}
        </>
      )}
      {linked && !sourceFallback && (
        <details className="text-sm text-slate-600">
          <summary>Source quotation for comparison</summary>
          <div className="mt-3">
            <AlibabaSourceQuote value={initial.alibabaSourceReview} />
          </div>
        </details>
      )}
    </div>
  );
}
