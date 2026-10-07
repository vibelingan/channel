/**
 * Which stored version of a product is public (DEC-1). The list, item, slug and
 * product-page endpoints and quote requests all call this one rule, so they can
 * never pick different versions. The Alibaba link is deliberately not checked:
 * synced and manual products with an approved version are treated the same.
 * Pure; never throws.
 *
 * Published as its own package subpath, not re-exported from `catalog/index.ts`:
 * `product-detail.ts` imports that index at load time, so re-exporting this
 * module (which imports `product-detail.ts`) from it would create a load cycle.
 */
import type { z } from 'zod';
import { CatalogDetailPublicationSchema } from './product-detail.ts';

export type CatalogDetailPublication = z.infer<typeof CatalogDetailPublicationSchema>;

export type PublicVersion =
  | { kind: 'approved'; publication: CatalogDetailPublication }
  | { kind: 'row' };

export function resolvePublicVersion(
  product: unknown,
  options: { detailEnabled: boolean },
): PublicVersion {
  if (!options.detailEnabled || !product || typeof product !== 'object') return { kind: 'row' };
  const id = Reflect.get(product, '_id');
  const parsed = CatalogDetailPublicationSchema.safeParse(
    Reflect.get(product, 'catalogDetailPublication'),
  );
  if (!parsed.success || typeof id !== 'string' || parsed.data.header._id !== id) {
    return { kind: 'row' };
  }
  return { kind: 'approved', publication: parsed.data };
}
