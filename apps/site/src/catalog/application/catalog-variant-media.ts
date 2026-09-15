import type { VariantSelection } from './catalog-variant-state.ts';

export function variantMediaSources(
  parentImages: readonly string[],
  selection: VariantSelection,
): readonly string[] {
  if (selection.status !== 'selected') return parentImages;
  // The server validates and publishes SKU media independently of product photos.
  // A product photo is not a fallback for a selected color, even when no mapping exists.
  return selection.variant.images;
}
