import type { CatalogDetailVariant } from '@vibelingan-channel/shared/catalog-detail';
import type { SharedDetailContent } from '../../i18n/catalog.ts';

export function CatalogSkuDisclosure({
  variant,
  copy,
}: { variant: CatalogDetailVariant; copy: SharedDetailContent }) {
  const inventory = variant.inventory;
  return (
    <div
      className="rounded-[var(--radius-card)] border border-brand-100 bg-brand-50 p-5"
      data-selected-configuration={variant.id}
    >
      <h2 className="font-display text-base font-semibold text-brand-950">{copy.selectedLabel}</h2>
      <dl className="mt-3 space-y-2">
        {variant.options.map((option, index) => (
          <div key={`${index}:${option.name}`} className="grid grid-cols-2 gap-4 text-sm">
            <dt className="break-words text-ink-muted">{option.name}</dt>
            <dd className="break-words font-medium text-ink">{option.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 border-t border-brand-100 pt-3 text-sm text-ink-soft">
        {inventory.state === 'reported'
          ? `${inventory.semantics === 'onHand' ? copy.onHandLabel : copy.sellableLabel}: ${inventory.quantity}`
          : copy.unknownAvailability}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{copy.sourceNote}</p>
      <details className="mt-4 text-xs text-ink-muted">
        <summary className="cursor-pointer py-1">{copy.identityLabel}</summary>
        <p className="mt-2 break-all font-mono">{variant.id}</p>
        {variant.sku && <p className="mt-1 break-all">{variant.sku}</p>}
      </details>
    </div>
  );
}
