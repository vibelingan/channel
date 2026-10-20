import { type CollectionDoc, isProductFamily } from '@vibelingan-channel/shared';
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
    readonly draftSaved = true,
  ) {
    const error = item?.error ?? item?.run?.error;
    const prefix = draftSaved ? 'Product saved. ' : 'Your form edits have been kept. ';
    const message =
      item?.state === 'confirmed'
        ? 'Publication was confirmed on the website. Review or reload the current product before continuing.'
        : item?.state === 'needs-action'
          ? `${prefix}Publishing needs attention: ${error?.message ?? 'Check its original task.'}`
          : !item || item.state === 'not-started'
            ? `${prefix}Publication did not start. ${cause instanceof AdminApiError ? cause.message : 'Review the same account before continuing.'}`
            : `${prefix}Publication is not confirmed. Check or continue its original task.`;
    super(
      error?.code ?? (cause instanceof AdminApiError ? cause.code : 'OPERATION_UNCONFIRMED'),
      message,
      item?.run?.error?.issues,
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
export function publishSavedProduct(
  product: CollectionDoc,
  guard: () => void = () => {},
): Promise<CollectionDoc> {
  return publishDraft({ ...product }, {}, guard, true);
}

/** One frozen edit and publication share the same owned task. */
export async function publishProductFromEditor(
  product: CollectionDoc,
  input: Record<string, unknown>,
  guard: () => void = () => {},
): Promise<CollectionDoc> {
  if (input.published !== true || input.archived === true)
    throw new AdminApiError('BAD_REQUEST', 'Use Publish only for an active draft.');
  const { published: _published, archived: _archived, ...values } = input;
  const family = Object.hasOwn(values, 'productFamily')
    ? values.productFamily
    : product.productFamily;
  if (!isProductFamily(family))
    throw new AdminApiError('INVALID_PRODUCT', 'Choose a website category before publishing.', [
      {
        code: 'MISSING_CATEGORY',
        stage: 'classification',
        path: 'productFamily',
        severity: 'error',
        remedy: 'classify',
      },
    ]);
  return publishDraft({ ...product }, values, guard, false);
}

function savedInput(item: PublicationBatchItem | undefined, alreadySaved: boolean) {
  const status = item?.run?.status ?? item?.check?.status;
  return alreadySaved || (status !== undefined && status.state !== 'reserved');
}

async function publishDraft(
  product: CollectionDoc,
  values: Record<string, unknown>,
  guard: () => void,
  alreadySaved: boolean,
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
    const attempt = createPublicationAttempt({
      productId: product._id,
      expectedUpdatedAt: revision,
      values,
    });
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
        alreadySaved
          ? 'Publishing is unavailable. The product is saved; open it to continue editing.'
          : 'Publishing is unavailable. Your current form edits have been kept.',
      );
    checkpoint = {
      scope: { productId: attempt.productId, operationId: attempt.operationId },
      ...(Object.keys(attempt.values).length === 0
        ? { originalStart: { expectedUpdatedAt: revision } }
        : {}),
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
        undefined,
        savedInput(item, alreadySaved),
      );
    return await currentPublishedProduct(item, assertCurrent);
  } catch (error) {
    if (error instanceof ProductPublicationError) throw error;
    let cause = error;
    // The batch clears confirmed tasks before the editor reads their exact saved version.
    if (batch && checkpoint && item) {
      try {
        batch.journal.retain({ ...checkpoint, scope: item.scope });
      } catch (storageError) {
        cause = new AggregateError(
          [error, storageError],
          'Keep this form open to recover its original publication.',
        );
      }
    }
    // run rejects before admitting work; worker failures return an item and retain their pointer.
    throw new ProductPublicationError(
      product,
      item && checkpoint ? batch?.owner : undefined,
      item ? checkpoint : undefined,
      item,
      cause,
      savedInput(item, alreadySaved),
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
    let cause = error;
    if (item) {
      try {
        batch.journal.retain({ ...checkpoint, scope: item.scope });
      } catch (storageError) {
        cause = new AggregateError(
          [error, storageError],
          'Keep this form open to recover its original publication.',
        );
      }
    }
    throw new ProductPublicationError(
      product,
      owner,
      checkpoint,
      item,
      cause,
      savedInput(item, checkpoint.originalStart !== undefined),
    );
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
