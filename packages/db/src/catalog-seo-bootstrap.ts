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
  // CloudBase expires transactions after 30 seconds. Keep each one to one product.
  for (let offset = 0; offset < requests.length; offset += 4) {
    const results = await Promise.allSettled(
      requests.slice(offset, offset + 4).map(async (request) =>
        store.transaction(async (tx): Promise<keyof typeof totals> => {
          if (request.kind !== 'product') throw Error('Unexpected bootstrap request');
          const head = await tx.get(
            'catalogPublicHeads',
            catalogPublicRecordId(config.siteOrigin, request.productId),
          );
          if (head) return 'tracked';
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
                await tx.set('catalogSeoRequests', { ...previous, previouslyPublic: true });
                return 'upgraded';
              }
              return 'preserved';
            }
          }
          await tx.set('catalogSeoRequests', request);
          return 'queued';
        }),
      ),
    );
    // Let in-flight transactions finish before reporting failure; no writes outlive this call.
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      totals[result.value]++;
    }
  }
  return totals;
}
