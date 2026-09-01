import {
  MANUAL_CATALOG_PRICING_SCHEMA_VERSION,
  MANUAL_PRICE_MAX_TIERS,
  type ManualCatalogPricing,
  validateManualCatalogPricing,
} from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { Select } from '../../components/form/Select.tsx';

interface Props {
  value: string;
  error?: string;
  onValidityChange?: (invalid: boolean) => void;
  onChange: (value: string) => void;
}

interface DraftTier {
  id: number;
  minQuantity: string;
  maxQuantity: string;
  unitPrice: string;
}

interface DraftPricing {
  currency: 'USD' | 'CNY';
  tiers: DraftTier[];
  sourceMalformed: boolean;
}

let nextTierId = 1;

export function parseMajorAmountToMinor(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}

export function formatMinorAsMajor(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

export function decodeManualPricing(value: string): ManualCatalogPricing {
  if (!value.trim()) {
    return {
      schemaVersion: MANUAL_CATALOG_PRICING_SCHEMA_VERSION,
      currency: 'USD',
      tiers: [],
    };
  }
  const parsed = JSON.parse(value);
  const result = validateManualCatalogPricing(parsed);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.value;
}

function draftFromValue(value: string): DraftPricing {
  try {
    const pricing = decodeManualPricing(value);
    return {
      currency: pricing.currency,
      sourceMalformed: false,
      tiers: pricing.tiers.map((tier) => ({
        id: nextTierId++,
        minQuantity: String(tier.minQuantity),
        maxQuantity: tier.maxQuantity === undefined ? '' : String(tier.maxQuantity),
        unitPrice: formatMinorAsMajor(tier.unitAmountMinor),
      })),
    };
  } catch {
    return { currency: 'USD', tiers: [], sourceMalformed: true };
  }
}

function parsePositiveInteger(value: string): number | null {
  return /^[1-9]\d*$/.test(value.trim()) ? Number(value) : null;
}

function validateDraft(draft: DraftPricing): { pricing?: ManualCatalogPricing; errors: string[] } {
  if (draft.sourceMalformed)
    return {
      errors: ['Stored tier pricing is malformed; clear it explicitly before replacing it.'],
    };
  if (draft.tiers.length === 0) return { pricing: undefined, errors: [] };
  const tiers = [];
  const errors: string[] = [];
  for (const [index, tier] of draft.tiers.entries()) {
    const minQuantity = parsePositiveInteger(tier.minQuantity);
    const maxQuantity = tier.maxQuantity.trim()
      ? parsePositiveInteger(tier.maxQuantity)
      : undefined;
    const unitAmountMinor = parseMajorAmountToMinor(tier.unitPrice);
    if (minQuantity === null)
      errors.push(`Tier ${index + 1}: minimum quantity must be a positive integer.`);
    if (tier.maxQuantity.trim() && maxQuantity === null)
      errors.push(`Tier ${index + 1}: maximum quantity must be a positive integer.`);
    if (unitAmountMinor === null)
      errors.push(`Tier ${index + 1}: unit price must have at most two decimal places.`);
    tiers.push({
      minQuantity: minQuantity ?? 0,
      ...(maxQuantity === undefined || maxQuantity === null ? {} : { maxQuantity }),
      unitAmountMinor: unitAmountMinor ?? -1,
    });
  }
  if (errors.length > 0) return { errors };
  const pricing = {
    schemaVersion: MANUAL_CATALOG_PRICING_SCHEMA_VERSION,
    currency: draft.currency,
    tiers,
  } satisfies ManualCatalogPricing;
  const result = validateManualCatalogPricing(pricing);
  return result.ok ? { pricing: result.value, errors: [] } : { errors: result.errors };
}

export function updateManualPricingTier(
  pricing: ManualCatalogPricing,
  index: number,
  field: 'minQuantity' | 'maxQuantity' | 'unitAmountMinor',
  rawValue: string,
): ManualCatalogPricing {
  const tiers = [...pricing.tiers];
  const current = tiers[index] ?? { minQuantity: 1, unitAmountMinor: 0 };
  if (field === 'unitAmountMinor') {
    tiers[index] = { ...current, unitAmountMinor: parseMajorAmountToMinor(rawValue) ?? -1 };
  } else if (field === 'maxQuantity' && rawValue.trim() === '') {
    const { maxQuantity: _, ...withoutMax } = current;
    tiers[index] = withoutMax;
  } else {
    tiers[index] = { ...current, [field]: Number(rawValue) };
  }
  return { ...pricing, tiers };
}

export function QuantityTierPricingEditor({ value, error, onValidityChange, onChange }: Props) {
  const [draft, setDraft] = useState<DraftPricing>(() => draftFromValue(value));
  const lastExternalValue = useRef(value);
  const synchronizingExternalValue = useRef(false);
  const validation = validateDraft(draft);

  useEffect(() => {
    if (value === lastExternalValue.current) return;
    lastExternalValue.current = value;
    synchronizingExternalValue.current = true;
    setDraft(draftFromValue(value));
  }, [value]);

  useEffect(() => {
    if (synchronizingExternalValue.current) {
      synchronizingExternalValue.current = false;
      return;
    }
    const invalid = validation.errors.length > 0;
    onValidityChange?.(invalid);
    if (invalid) return;
    const next = validation.pricing ? JSON.stringify(validation.pricing) : '';
    if (next !== lastExternalValue.current) {
      lastExternalValue.current = next;
      onChange(next);
    }
  }, [onChange, onValidityChange, validation.errors.length, validation.pricing]);

  function patchTier(id: number, patch: Partial<Omit<DraftTier, 'id'>>) {
    setDraft((current) => ({
      ...current,
      sourceMalformed: false,
      tiers: current.tiers.map((tier) => (tier.id === id ? { ...tier, ...patch } : tier)),
    }));
  }

  function addTier() {
    if (draft.sourceMalformed || validation.errors.length > 0) return;
    setDraft((current) => {
      if (current.tiers.length >= MANUAL_PRICE_MAX_TIERS) return current;
      const tiers = [...current.tiers];
      const last = tiers.at(-1);
      let nextMin = 1;
      if (last) {
        const lastMin = parsePositiveInteger(last.minQuantity) ?? 1;
        const lastMax = parsePositiveInteger(last.maxQuantity);
        if (lastMax === null) {
          const closedMax = lastMin;
          tiers[tiers.length - 1] = { ...last, maxQuantity: String(closedMax) };
          nextMin = closedMax + 1;
        } else {
          nextMin = lastMax + 1;
        }
      }
      return {
        ...current,
        sourceMalformed: false,
        tiers: [
          ...tiers,
          { id: nextTierId++, minQuantity: String(nextMin), maxQuantity: '', unitPrice: '0.00' },
        ],
      };
    });
  }

  function removeTier(id: number) {
    const index = draft.tiers.findIndex((tier) => tier.id === id);
    setDraft((current) => ({ ...current, tiers: current.tiers.filter((tier) => tier.id !== id) }));
    window.requestAnimationFrame(() => {
      const nextIndex = Math.max(0, Math.min(index, draft.tiers.length - 2));
      document
        .querySelector<HTMLElement>(`[data-tier-index="${nextIndex}"] input, [data-add-price-tier]`)
        ?.focus();
    });
  }

  function clear() {
    setDraft({ currency: draft.currency, tiers: [], sourceMalformed: false });
  }

  const shownError = error ?? validation.errors[0];
  const describedBy = shownError ? 'manualCatalogPricing-error' : undefined;

  return (
    <fieldset className="space-y-3" aria-describedby={describedBy}>
      <legend className="text-sm font-medium text-slate-700">Quantity Tier Pricing</legend>
      <p className="text-xs text-slate-500">
        Optional. Configure up to four quantity ranges; legacy MOQ and scalar prices remain
        available.
      </p>
      <Select
        id="manualCatalogPricing-currency"
        label="Currency"
        options={['USD', 'CNY']}
        value={draft.currency}
        onChange={(currency) =>
          setDraft((current) => ({ ...current, currency: currency as 'USD' | 'CNY' }))
        }
        invalid={Boolean(shownError)}
        describedBy={describedBy}
      />

      {draft.tiers.map((tier, index) => (
        <fieldset
          key={tier.id}
          data-tier-index={index}
          className="grid grid-cols-1 gap-3 border border-slate-200 p-3 sm:grid-cols-3"
        >
          <legend className="px-1 text-xs font-semibold text-slate-600">Tier {index + 1}</legend>
          <label className="text-xs text-slate-600">
            Minimum quantity
            <input
              type="text"
              inputMode="numeric"
              value={tier.minQuantity}
              onChange={(event) => patchTier(tier.id, { minQuantity: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              aria-invalid={Boolean(shownError) || undefined}
              aria-describedby={describedBy}
            />
          </label>
          <label className="text-xs text-slate-600">
            Maximum quantity
            <input
              type="text"
              inputMode="numeric"
              value={tier.maxQuantity}
              placeholder="No maximum"
              onChange={(event) => patchTier(tier.id, { maxQuantity: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              aria-invalid={Boolean(shownError) || undefined}
              aria-describedby={describedBy}
            />
          </label>
          <label className="text-xs text-slate-600">
            Unit price ({draft.currency})
            <input
              inputMode="decimal"
              value={tier.unitPrice}
              onChange={(event) => patchTier(tier.id, { unitPrice: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              aria-invalid={Boolean(shownError) || undefined}
              aria-describedby={describedBy}
            />
          </label>
          <div className="sm:col-span-3">
            <button
              type="button"
              onClick={() => removeTier(tier.id)}
              aria-label={`Remove tier ${index + 1}`}
              className="min-h-10 border border-red-300 px-3 text-xs text-red-700"
            >
              Remove
            </button>
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={addTier}
          disabled={
            draft.tiers.length >= MANUAL_PRICE_MAX_TIERS ||
            draft.sourceMalformed ||
            validation.errors.length > 0
          }
          data-add-price-tier
          className="min-h-11 border border-brand-300 px-4 text-sm font-semibold text-brand-700 disabled:opacity-40"
        >
          Add price tier
        </button>
        {(draft.tiers.length > 0 || draft.sourceMalformed) && (
          <button type="button" onClick={clear} className="min-h-11 px-4 text-sm text-slate-600">
            Clear tier pricing
          </button>
        )}
      </div>
      {shownError && (
        <p id="manualCatalogPricing-error" className="text-xs text-red-600" role="alert">
          {shownError}
        </p>
      )}
    </fieldset>
  );
}
