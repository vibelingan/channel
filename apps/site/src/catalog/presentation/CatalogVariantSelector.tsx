import { useId } from 'react';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import type { DetailPages } from '../application/catalog-detail-pages.ts';
import { catalogVariantLabels } from '../application/catalog-variant-labels.ts';
import type { VariantSelection } from '../application/catalog-variant-state.ts';

export function CatalogVariantSelector({
  pages,
  selection,
  copy,
  onSelect,
}: {
  pages: DetailPages;
  selection: VariantSelection;
  copy: SharedDetailContent;
  onSelect: (id: string) => void;
}) {
  const group = useId();
  if (!pages.items.length) return <p className="text-sm text-ink-muted">{copy.noVariants}</p>;
  // These are canonical row choices, never synthetic option combinations.
  const labels = catalogVariantLabels(
    pages.items,
    (index) =>
      `${copy.variantLabel} ${index + 1 + (pages.mode === 'paged' ? (pages.currentPage.variants.page - 1) * pages.currentPage.variants.pageSize : 0)}`,
  );
  const label = (index: number) => labels[index];
  const selectedId = selection.status === 'selected' ? selection.variant.id : '';
  const counts = new Map<string, number>();
  for (const value of labels) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (
    <fieldset className="min-w-0" data-catalog-variant-selector>
      <legend className="mb-3 text-sm font-semibold text-ink">{copy.configurationLabel}</legend>
      {pages.items.length > 12 ? (
        <select
          aria-label={copy.configurationLabel}
          value={pages.items.some((v) => v.id === selectedId) ? selectedId : ''}
          onChange={(event) => onSelect(event.target.value)}
          className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
        >
          <option value="" disabled>
            {copy.configurationLabel}
          </option>
          {pages.items.map((variant, index) => (
            <option key={variant.id} value={variant.id}>
              {label(index)} · {variant.id}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex flex-wrap gap-2">
          {pages.items.map((variant, index) => (
            <label key={variant.id} className="relative min-w-0 max-w-full cursor-pointer">
              <input
                className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
                type="radio"
                name={group}
                value={variant.id}
                checked={selectedId === variant.id}
                aria-label={`${label(index)} · ${variant.id}`}
                onChange={() => onSelect(variant.id)}
              />
              <span className="flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-ink-soft peer-checked:border-brand-700 peer-checked:bg-brand-50 peer-checked:text-brand-700 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600 peer-focus-visible:ring-offset-2">
                <span className="break-words">{label(index)}</span>
                {(counts.get(labels[index]) ?? 0) > 1 && (
                  <span className="ml-2 break-all text-xs font-normal">{variant.id}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      {pages.mode !== 'complete' && (
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">{copy.partialLabel}</p>
      )}
    </fieldset>
  );
}
