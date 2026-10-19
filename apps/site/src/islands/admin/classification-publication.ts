import {
  CatalogClassificationAssignmentRequestSchema,
  CatalogClassificationAssignmentResultSchema,
} from '@vibelingan-channel/shared';
import { AdminApiError, type BatchUpdateResult } from './api.ts';
import { createPublicationAttempt } from './catalog-product-operation-api.ts';
import type { PublicationBatchItem } from './catalog-publication-batch.ts';

/** All classification receipts must match before any publication attempt is created. */
export function classificationPublicationAttempts(input: unknown, response: unknown) {
  const command = CatalogClassificationAssignmentRequestSchema.parse(input);
  const result = CatalogClassificationAssignmentResultSchema.parse(response);
  const ids = command.products.map((item) => item.productId);
  const saved = new Map(result.results.map((item) => [item.productId, item]));
  if (
    command.includeSavedRevision !== true ||
    result.refreshRequired ||
    ids.length === 0 ||
    new Set(ids).size !== ids.length ||
    saved.size !== ids.length ||
    result.results.length !== ids.length ||
    ids.some((id) => {
      const item = saved.get(id);
      return (
        !item ||
        item.status !== 'saved' ||
        typeof item.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(item.updatedAt))
      );
    })
  )
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Publication blocked: classification results were not confirmed. Refresh products.',
    );
  return ids.map((productId) => {
    const item = saved.get(productId);
    if (!item || typeof item.updatedAt !== 'string') throw new Error('Missing checked receipt');
    return createPublicationAttempt({ productId, expectedUpdatedAt: item.updatedAt, values: {} });
  });
}

export function classificationPublicationFeedback(
  items: readonly PublicationBatchItem[],
): BatchUpdateResult {
  return {
    updated: items.filter((item) => item.state === 'confirmed').length,
    items: items.flatMap((item) =>
      item.state === 'confirmed' ? [{ _id: item.scope.productId, name: item.check.name }] : [],
    ),
    failures: items.flatMap((item) => {
      if (item.state === 'confirmed') return [];
      const rejected = ['needs-action', 'historical', 'cancelled'].includes(item.state);
      const message =
        item.error?.message ??
        item.run?.error?.message ??
        (item.state === 'cancelled'
          ? 'Publication stopped. Saved draft changes remain.'
          : item.state === 'historical'
            ? 'This original publication is no longer current. Review the product.'
            : item.state === 'not-started'
              ? 'Publication has not started. Continue the same selection.'
              : 'Publication is not confirmed. Check or continue its original task.');
      return [
        {
          id: item.scope.productId,
          code:
            item.state === 'cancelled'
              ? 'OPERATION_CANCELLED'
              : (item.error?.code ?? item.run?.error?.code ?? 'OPERATION_UNCONFIRMED'),
          message,
          outcome: rejected
            ? ('rejected' as const)
            : item.state === 'not-started'
              ? ('not-attempted' as const)
              : ('unconfirmed' as const),
          retryable: !rejected,
        },
      ];
    }),
  };
}
