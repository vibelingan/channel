import type { CatalogDetailVariant } from '@vibelingan-channel/shared/catalog-detail';
import type { DetailPages } from './catalog-detail-pages.ts';

export type VariantSelection =
  | { status: 'selected'; variant: CatalogDetailVariant }
  | { status: 'pending' | 'invalid'; requestedId: string }
  | { status: 'none' | 'unselected' };

export type OptionMatch =
  | { status: 'matched'; variant: CatalogDetailVariant }
  | { status: 'ambiguous'; variants: readonly CatalogDetailVariant[] }
  | { status: 'incomplete' | 'no-match' | 'identity-required' | 'invalid-options' };

export function resolveVariantSelection(
  pages: DetailPages,
  requestedId?: string,
): VariantSelection {
  if (requestedId !== undefined) {
    const variant = pages.items.find((item) => item.id === requestedId);
    if (variant) return { status: 'selected', variant };
    return { status: pages.mode === 'complete' ? 'invalid' : 'pending', requestedId };
  }
  if (pages.mode !== 'complete') return { status: 'unselected' };
  const first = pages.items[0];
  return first ? { status: 'selected', variant: first } : { status: 'none' };
}

function uniqueAxes(
  options: readonly { name: string; value: string }[],
): Map<string, string> | undefined {
  const axes = new Map<string, string>();
  for (const option of options) {
    if (axes.has(option.name) && axes.get(option.name) !== option.value) return undefined;
    axes.set(option.name, option.value);
  }
  return axes;
}

/** Options filter real canonical rows; they never generate a Cartesian product of SKUs. */
export function matchVariantOptions(
  pages: DetailPages,
  options: readonly { name: string; value: string }[],
): OptionMatch {
  if (pages.mode !== 'complete') return { status: 'incomplete' };
  const selected = uniqueAxes(options);
  if (!selected) return { status: 'invalid-options' };
  const rows = pages.items.map((variant) => ({ variant, axes: uniqueAxes(variant.options) }));
  // A conflicting axis has no truthful single-valued selector: retain the direct-ID route.
  if (rows.some((row) => !row.axes)) return { status: 'identity-required' };
  const variants = rows
    .filter((row) => [...selected].every(([name, value]) => row.axes?.get(name) === value))
    .map((row) => row.variant);
  if (variants.length === 0) return { status: 'no-match' };
  if (variants.length === 1) return { status: 'matched', variant: variants[0] };
  return { status: 'ambiguous', variants };
}
