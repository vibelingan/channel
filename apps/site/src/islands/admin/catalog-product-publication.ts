import type { CollectionDoc } from '@vibelingan-channel/shared';
import { AdminApiError, fetchCatalogDetailCapabilities, getRecord } from './api.ts';
import { CreatedProductChangedError } from './catalog-product-create-api.ts';
import {
  type PublicationCheckpoint,
  createPublicationAttempt,
} from './catalog-product-operation-api.ts';
import { type PublicationBatchItem, createPublicationBatch } from './catalog-publication-batch.ts';

export type PublicationOwner = { actorId: string; endpoint: string };
export class ProductPublicationError extends AdminApiError {
  constructor(
    readonly product: CollectionDoc,
    readonly owner: PublicationOwner | undefined,
    readonly checkpoint: PublicationCheckpoint | undefined,
    readonly item: PublicationBatchItem | undefined,
    cause?: unknown,
  ) {
    const error = item?.error ?? item?.run?.error;
    const message =
      item?.state === 'confirmed'
        ? 'Publication was confirmed on the website. Review or reload the current product before continuing.'
        : item?.state === 'needs-action'
          ? `Product saved. Publishing needs attention: ${error?.message ?? 'Check its original task.'}`
          : !item || item.state === 'not-started'
            ? `Product saved. Publication did not start. ${cause instanceof AdminApiError ? cause.message : 'Review the same account before continuing.'}`
            : 'Product saved. Publication is not confirmed. Check or continue its original task.';
    super(
      error?.code ?? (cause instanceof AdminApiError ? cause.code : 'OPERATION_UNCONFIRMED'),
      message,
    );
    this.cause = cause;
  }
}

async function currentPublishedProduct(
  item: PublicationBatchItem,
  guard: () => void,
): Promise<CollectionDoc> {
  guard();
  const product = await getRecord('products', item.scope.productId, AbortSignal.timeout(8000));
  guard();
  if (item.state === 'confirmed') {
    const receipt = product.catalogDetailApprovalReceipt;
    if (
      product.published !== true ||
      !receipt ||
      typeof receipt !== 'object' ||
      Reflect.get(receipt, 'operationId') !== item.scope.operationId ||
      Reflect.get(receipt, 'revision') !== item.check.revision ||
      product.updatedAt !== item.check.status.completion.productUpdatedAt
    )
      throw new AdminApiError(
        'CONFLICT',
        'The product changed after publication was confirmed. Review its current state.',
      );
  }
  return product;
}

/** Publishing a saved draft uses the same owned protocol as classification publication. */
export async function publishSavedProduct(
  product: CollectionDoc,
  guard: () => void = () => {},
): Promise<CollectionDoc> {
  guard();
  if (product.published === true || product.archived === true)
    throw new CreatedProductChangedError(product);
  let batch: ReturnType<typeof createPublicationBatch> | undefined;
  let checkpoint: PublicationCheckpoint | undefined;
  let item: PublicationBatchItem | undefined;
  try {
    const revision = product.updatedAt ?? null;
    if (revision !== null && typeof revision !== 'string')
      throw new AdminApiError('INVALID_RESPONSE', 'Reload the product before publishing.');
    const publisher = createPublicationBatch();
    batch = publisher;
    const assertCurrent = () => {
      guard();
      publisher.assertCurrent();
    };
    const capabilities = await fetchCatalogDetailCapabilities(AbortSignal.timeout(8000));
    assertCurrent();
    if (!capabilities.enabled)
      throw new AdminApiError(
        'FORBIDDEN',
        'Publishing is unavailable. The product is saved; open it to continue editing.',
      );
    const attempt = createPublicationAttempt({
      productId: product._id,
      expectedUpdatedAt: revision,
      values: {},
    });
    checkpoint = {
      scope: { productId: attempt.productId, operationId: attempt.operationId },
      originalStart: { expectedUpdatedAt: revision },
    };
    const result = await publisher.run([attempt]);
    item = result.items[0];
    assertCurrent();
    if (item)
      checkpoint = publisher.journal
        .read()
        .entries.find(
          (entry) =>
            entry.scope.productId === item?.scope.productId &&
            entry.scope.operationId === item.scope.operationId,
        ) ?? { ...checkpoint, scope: item.scope };
    // A definite rejection of the first start has no reserved task to stop. Keep the product,
    // but let its editor open instead of trapping it behind a task that never existed.
    if (item?.state === 'needs-action' && item.run && !item.run.status && !item.scope.inputDigest) {
      if (publisher.journal.forget(item.scope).durability === 'persistent') checkpoint = undefined;
    }
    if (!item || item.state !== 'confirmed')
      throw new ProductPublicationError(
        product,
        checkpoint ? publisher.owner : undefined,
        checkpoint,
        item,
      );
    return await currentPublishedProduct(item, assertCurrent);
  } catch (error) {
    if (error instanceof ProductPublicationError) throw error;
    // run rejects before admitting work; worker failures return an item and retain their pointer.
    throw new ProductPublicationError(
      product,
      item && checkpoint ? batch?.owner : undefined,
      item ? checkpoint : undefined,
      item,
      error,
    );
  }
}

export async function recoverProductPublication(
  product: CollectionDoc,
  owner: PublicationOwner,
  checkpoint: PublicationCheckpoint,
  mode: 'check' | 'continue' | 'cancel',
) {
  const batch = createPublicationBatch();
  if (batch.owner.actorId !== owner.actorId || batch.owner.endpoint !== owner.endpoint)
    throw new AdminApiError(
      'UNAUTHORIZED',
      'Return to the original account and environment to recover this publication.',
    );
  let item: PublicationBatchItem | undefined;
  try {
    const result = await batch.run([checkpoint], undefined, mode);
    batch.assertCurrent();
    item = result.items[0];
    if (!item)
      throw new AdminApiError('INVALID_RESPONSE', 'The original publication could not be checked.');
    const latest = batch.journal
      .read()
      .entries.find(
        (entry) =>
          entry.scope.operationId === checkpoint.scope.operationId &&
          entry.scope.productId === checkpoint.scope.productId,
      ) ?? { ...checkpoint, scope: item.scope };
    const saved =
      item.stoppedBeforeStart || ['confirmed', 'historical', 'cancelled'].includes(item.state)
        ? await currentPublishedProduct(item, batch.assertCurrent)
        : undefined;
    return {
      item,
      checkpoint: latest,
      product: saved,
      stoppedBeforeStart: item.stoppedBeforeStart === true,
    };
  } catch (error) {
    throw new ProductPublicationError(product, owner, checkpoint, item, error);
  }
}

/** Read only local pointers; fresh authorization is checked again before any task action. */
export function pendingProductPublications(productId: string) {
  const batch = createPublicationBatch();
  batch.assertCurrent();
  const snapshot = batch.journal.read();
  if (snapshot.problems.length)
    throw new AdminApiError(
      'RECOVERY_CORRUPT',
      'Publication recovery could not be read. Keep this form open and restore browser storage before editing the saved product.',
    );
  return {
    owner: batch.owner,
    entries: snapshot.entries.filter((entry) => entry.scope.productId === productId),
  };
}
