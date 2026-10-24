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

/**
 * The configuration a tapped photo stands for: only when the photo belongs to
 * exactly one configuration. A photo shared by several, or by none, is not a
 * choice of configuration, so the selection stays as it is.
 */
export function configurationForPhoto(
  variants: readonly { id: string; images: readonly string[] }[],
  photo: string,
  normalize: (source: string) => string | undefined = (source) => source,
): string | undefined {
  const owners = variants.filter((variant) =>
    variant.images.some((image) => normalize(image) === photo),
  );
  return owners.length === 1 ? owners[0]?.id : undefined;
}
