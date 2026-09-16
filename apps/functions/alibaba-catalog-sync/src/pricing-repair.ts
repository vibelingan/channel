/** Repair an omitted projection from completed source mirrors; never call Alibaba or publish a product. */
import { randomUUID } from 'node:crypto';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  acquireAlibabaSyncLease,
  get,
  list,
  releaseAlibabaSyncLease,
  renewAlibabaSyncLease,
} from '@vibelingan-channel/db';
import { z } from 'zod';
import { promoteLinkedProduct } from './promotion.ts';

export const PricingRepairInputSchema = z
  .object({ afterId: z.string().min(1).max(200).optional() })
  .strict();

export async function repairMissingSourcePricing(input: z.infer<typeof PricingRepairInputSchema>) {
  const holder = `pricing-repair-${randomUUID()}`;
  const now = () => new Date().toISOString();
  const lease = await acquireAlibabaSyncLease('primary', holder, now(), ALIBABA_SYNC_LEASE_TTL_MS);
  if (lease.result !== 'granted')
    throw new Error(`Pricing repair cannot start: lease ${lease.result}.`);
  try {
    // A quarantined/unfinished run may have mutated mirrors. Only terminal clean
    // provenance is admitted below, even when no worker currently owns the lease.
    const page = await list({
      collection: 'products',
      page: 1,
      pageSize: 20,
      sort: [{ field: '_id', dir: 'asc' }],
      ...(input.afterId
        ? {
            filter: {
              combinator: 'and' as const,
              clauses: [{ field: '_id', op: 'gt' as const, value: input.afterId }],
            },
          }
        : {}),
    });
    let repaired = 0;
    const deferred: string[] = [];
    for (const product of page.items) {
      if (
        Object.hasOwn(product, 'alibabaCatalogPricing') ||
        typeof product.alibabaPrimarySourceKey !== 'string' ||
        !product.alibabaPrimarySourceKey ||
        product.archived === true
      )
        continue;
      const sourceKey = product.alibabaPrimarySourceKey;
      const source = await get('alibabaSourceProducts', sourceKey);
      const runId = source?.lastSeenRunId;
      const run = typeof runId === 'string' ? await get('alibabaSyncRuns', runId) : null;
      if (source?.active !== true || run?.status !== 'completed') {
        deferred.push(product._id);
        continue;
      }
      if (
        typeof source.lastChangedRunId === 'string' &&
        source.lastChangedRunId &&
        source.lastChangedRunId !== runId
      ) {
        const changedRun = await get('alibabaSyncRuns', source.lastChangedRunId);
        if (changedRun?.status !== 'completed') {
          deferred.push(product._id);
          continue;
        }
      }
      const renewed = await renewAlibabaSyncLease(
        'primary',
        holder,
        lease.fence,
        now(),
        ALIBABA_SYNC_LEASE_TTL_MS,
      );
      if (!renewed) throw new Error('Pricing repair lost the sync lease. Retry this page.');
      const result = await promoteLinkedProduct({
        sourceKey,
        guard: { connectionId: 'primary', holder, fence: lease.fence, now: now() },
        now: now(),
      });
      if (!result.ok) throw new Error(`Pricing repair stopped: ${result.reason}. Retry this page.`);
      repaired += 1;
    }
    return {
      visited: page.items.length,
      repaired,
      deferred,
      nextId: page.items.length === 20 ? (page.items.at(-1)?._id ?? null) : null,
    };
  } finally {
    await releaseAlibabaSyncLease('primary', holder, lease.fence, now());
  }
}
