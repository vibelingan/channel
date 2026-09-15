import { PRODUCT_FAMILY_OPTIONS, isProductFamily } from '@vibelingan-channel/shared';
import { useState } from 'react';
import { Select } from '../../components/form/Select.tsx';
import { ADMIN_PRODUCT_FAMILY_LABELS } from './product-family-tabs.ts';

/** Explicit selection + confirmation; choosing an option never starts a write. */
export function BatchCategoryAssignment({
  count,
  busy,
  onApply,
}: {
  count: number;
  busy: boolean;
  onApply: (values: Record<string, unknown>) => void;
}) {
  const [family, setFamily] = useState('');
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="w-full border-t border-brand-200 pt-3">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Website main category"
          value={family}
          options={PRODUCT_FAMILY_OPTIONS.map((value) => ({
            value,
            label: ADMIN_PRODUCT_FAMILY_LABELS[value],
          }))}
          disabled={busy}
          onChange={(value) => {
            setFamily(value);
            setConfirming(false);
          }}
        />
        <button
          type="button"
          disabled={busy || !isProductFamily(family)}
          className="min-h-11 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
          onClick={() => setConfirming(true)}
        >
          Assign category
        </button>
      </div>
      {confirming && isProductFamily(family) && (
        <fieldset
          className="mt-3 rounded-lg bg-white p-3 text-sm"
          aria-label="Confirm category assignment"
        >
          <p>
            Assign {count} selected products to {ADMIN_PRODUCT_FAMILY_LABELS[family]}? Existing
            website categories will be replaced. Drafts will not be published. Price and images stay
            unchanged.
          </p>
          <p className="mt-1 text-slate-600">
            The optional Headphone type is cleared when moving out of Headphones. Future syncs
            preserve your website category.
          </p>
          <div className="mt-3 flex gap-4">
            <button
              type="button"
              disabled={busy}
              className="font-semibold text-brand-700"
              onClick={() => {
                setConfirming(false);
                onApply({ productFamily: family });
              }}
            >
              Confirm assignment
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
