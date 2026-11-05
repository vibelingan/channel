import { productPath } from './product-identity.ts';
import type { ProductSnapshot } from './product-snapshot.ts';
/** Missing historical dates stay absent; build and supplier polling times are not content changes. */
export function productSitemapDates(snapshot: ProductSnapshot): ReadonlyMap<string, string> {
  return new Map(
    snapshot.products.flatMap((entry) =>
      entry.publicVersion?.changedAt
        ? [
            [
              new URL(productPath(entry.product._id), snapshot.siteOrigin).href,
              entry.publicVersion.changedAt,
            ] as const,
          ]
        : [],
    ),
  );
}
