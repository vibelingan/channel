import type { CatalogDetailVariant } from '@vibelingan-channel/shared/catalog-detail';

/** Use only varying axes in compact labels; full specifications stay in the detail panel. */
export function catalogVariantLabels(
  variants: readonly CatalogDetailVariant[],
  fallback: (index: number) => string,
): string[] {
  const axes = new Map<string, Set<string>>();
  for (const variant of variants)
    for (const option of variant.options) {
      const values = axes.get(option.name) ?? new Set<string>();
      values.add(option.value);
      axes.set(option.name, values);
    }
  return variants.map(
    (variant, index) =>
      variant.options
        .filter((option) => (axes.get(option.name)?.size ?? 0) > 1)
        .map((option) => option.value)
        .join(' / ') ||
      variant.sku ||
      fallback(index),
  );
}
