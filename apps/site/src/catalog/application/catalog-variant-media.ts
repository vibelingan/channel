import type { VariantSelection } from './catalog-variant-state.ts';

export function variantMediaSources(
  parentImages: readonly string[],
  selection: VariantSelection,
): readonly string[] {
  if (selection.status !== 'selected') return parentImages;
  const approved = new Set(parentImages);
  const explicit = selection.variant.images.filter((source) => approved.has(source));
  // Reorder only; normalization, deduplication and bounds belong to catalog-media.
  return explicit.length ? [...explicit, ...parentImages] : parentImages;
}
