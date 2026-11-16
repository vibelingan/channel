import type { CatalogPublicChangeStore } from './catalog-public-changes.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import {
  type CatalogSeoRecordingConfig,
  CatalogSeoRecordingConfigSchema,
  CatalogSeoRequestSchema,
  createCatalogSeoRequest,
} from './catalog-seo-requests.ts';

/** Recheck explicit public or formerly public IDs, including products with an existing head. */
export async function recheckCatalogSeoRequests(
  store: CatalogSeoStore,
  options: CatalogSeoRecordingConfig,
  productIds: readonly string[],
  now: string,
  assertCanQueue: (tx: CatalogPublicChangeStore) => Promise<void>,
) {
  const config = CatalogSeoRecordingConfigSchema.parse(options);
  if (productIds.length > 50000) throw Error('Catalog recheck inventory exceeds bound');
  if (typeof assertCanQueue !== 'function')
    throw Error('Catalog recheck requires a publication fence');
  const requests = [...new Set(productIds)].map((productId) =>
    createCatalogSeoRequest(
      config.siteOrigin,
      { kind: 'product', productId, previouslyPublic: true },
      now,
    ),
  );
  const totals = { queued: 0, preserved: 0, upgraded: 0 };
  for (let offset = 0; offset < requests.length; offset += 4) {
    const batch = requests.slice(offset, offset + 4);
    const results = await Promise.allSettled(
      batch.map(async (request) =>
        store.transaction(async (tx): Promise<keyof typeof totals> => {
          // The same transaction must read the delivery fence before any request write.
          await assertCanQueue(tx);
          if (request.kind !== 'product') throw Error('Unexpected catalog recheck request');
          const row = await tx.get('catalogSeoRequests', request._id);
          if (row) {
            const previous = CatalogSeoRequestSchema.parse(row);
            if (
              previous._id !== request._id ||
              previous.kind !== 'product' ||
              previous.productId !== request.productId ||
              previous.siteOrigin !== config.siteOrigin
            )
              throw Error('Existing catalog recheck request belongs to another product');
            if (previous.state === 'pending') {
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
    // Drain the batch before rejecting so no writes outlive this call or overlap a retry.
    const failures: Error[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') totals[result.value]++;
      else {
        const request = batch[index];
        failures.push(
          new Error(
            `Catalog recheck failed for product ${request?.kind === 'product' ? request.productId : index}`,
            { cause: result.reason },
          ),
        );
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Catalog recheck batch failed');
  }
  return totals;
}
