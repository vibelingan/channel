import { catalogPublicRecordId } from './catalog-public-changes.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import {
  type CatalogSeoRecordingConfig,
  CatalogSeoRecordingConfigSchema,
  CatalogSeoRequestSchema,
  createCatalogSeoRequest,
} from './catalog-seo-requests.ts';

/** Seed existing accepted URLs without changing products or replacing a newer pending request. */
export async function seedCatalogSeoRequests(
  store: CatalogSeoStore,
  options: CatalogSeoRecordingConfig,
  productIds: readonly string[],
  now: string,
) {
  const config = CatalogSeoRecordingConfigSchema.parse(options);
  if (productIds.length > 50000) throw Error('Catalog bootstrap inventory exceeds bound');
  const requests = [...new Set(productIds)].map((productId) =>
    createCatalogSeoRequest(
      config.siteOrigin,
      { kind: 'product', productId, previouslyPublic: true },
      now,
    ),
  );
  const totals = { queued: 0, preserved: 0, tracked: 0, upgraded: 0 };
  for (let offset = 0; offset < requests.length; offset += 20) {
    const counts = await store.transaction(async (tx) => {
      const writes = [];
      const counts = { queued: 0, preserved: 0, tracked: 0, upgraded: 0 };
      for (const request of requests.slice(offset, offset + 20)) {
        if (request.kind !== 'product') throw Error('Unexpected bootstrap request');
        const head = await tx.get(
          'catalogPublicHeads',
          catalogPublicRecordId(config.siteOrigin, request.productId),
        );
        if (head) {
          counts.tracked++;
          continue;
        }
        const row = await tx.get('catalogSeoRequests', request._id);
        if (row) {
          const previous = CatalogSeoRequestSchema.parse(row);
          if (
            previous.kind !== 'product' ||
            previous.productId !== request.productId ||
            previous.siteOrigin !== config.siteOrigin
          )
            throw Error('Existing bootstrap request belongs to another product');
          if (previous.state === 'pending') {
            // This monotone flag also covers an accepted URL withdrawn before its first tracked head.
            if (!previous.previouslyPublic) {
              writes.push({ ...previous, previouslyPublic: true });
              counts.upgraded++;
            } else counts.preserved++;
            continue;
          }
        }
        writes.push(request);
        counts.queued++;
      }
      for (const request of writes) await tx.set('catalogSeoRequests', request);
      return counts;
    });
    for (const key of ['queued', 'preserved', 'tracked', 'upgraded'] as const)
      totals[key] += counts[key];
  }
  return totals;
}
