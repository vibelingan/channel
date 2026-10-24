import { type CollectionDoc, isProductFamily } from '@vibelingan-channel/shared';
import {
  AdminApiError,
  type BatchUpdateFailure,
  type BatchUpdateResult,
  getRecord,
} from './api.ts';
import {
  type PublicationCheckpoint,
  createPublicationAttempt,
} from './catalog-product-operation-api.ts';
import {
  type BatchEntry,
  type PublicationBatchItem,
  createPublicationBatch,
} from './catalog-publication-batch.ts';
import { classificationPublicationFeedback as publicationFeedback } from './classification-publication.ts';
import { reviewLabel } from './review-reason.ts';

export type TablePublicationRecovery = {
  owner: { actorId: string; endpoint: string };
  checkpoints: PublicationCheckpoint[];
};
function pointer(entry: BatchEntry): PublicationCheckpoint {
  return 'action' in entry
    ? {
        scope: { productId: entry.productId, operationId: entry.operationId },
        originalStart: { expectedUpdatedAt: entry.expectedUpdatedAt },
      }
    : structuredClone(entry);
}
function failure(id: string, error: unknown, retryable = false): BatchUpdateFailure {
  return {
    id,
    code: error instanceof AdminApiError ? error.code : 'UNAVAILABLE',
    message:
      error instanceof Error
        ? error.message
        : 'Product status is unavailable. Refresh the selection before publishing.',
    outcome:
      error instanceof AdminApiError &&
      ['INVALID_PRODUCT', 'VALIDATION_ERROR', 'BAD_REQUEST', 'CONFLICT', 'BUSY'].includes(
        error.code,
      )
        ? 'rejected'
        : 'not-attempted',
    retryable,
  };
}
function recovery(
  batch: ReturnType<typeof createPublicationBatch>,
  entries: readonly BatchEntry[],
  items: readonly PublicationBatchItem[],
) {
  const current = batch.journal.read().entries;
  return {
    owner: batch.owner,
    checkpoints: entries.flatMap((entry) => {
      const original = pointer(entry);
      const item = items.find(
        (value) =>
          value.scope.productId === original.scope.productId &&
          value.scope.operationId === original.scope.operationId,
      );
      if (
        item &&
        (['confirmed', 'historical', 'cancelled'].includes(item.state) || item.stoppedBeforeStart)
      )
        return [];
      return [
        current.find(
          (value) =>
            value.scope.productId === original.scope.productId &&
            value.scope.operationId === original.scope.operationId,
        ) ?? { ...original, ...(item ? { scope: item.scope } : {}) },
      ];
    }),
  };
}
async function run(
  batch: ReturnType<typeof createPublicationBatch>,
  entries: BatchEntry[],
  mode: 'continue' | 'check' | 'cancel',
) {
  let items: PublicationBatchItem[];
  try {
    items = (await batch.run(entries, undefined, mode)).items;
  } catch (error) {
    batch.assertCurrent();
    items = entries.map((entry) => ({
      state: 'not-started',
      scope: pointer(entry).scope,
      error: {
        code: error instanceof AdminApiError ? error.code : 'UNAVAILABLE',
        message:
          error instanceof Error
            ? error.message
            : 'Check the original publications before continuing.',
      },
    }));
  }
  batch.assertCurrent();
  return { ...publicationFeedback(items), publication: recovery(batch, entries, items) };
}

/** Captures the whole selection before dispatch. Empty publication input never changes classification. */
export async function publishTableSelection(
  inputIds: readonly string[],
  expectedRevisions?: ReadonlyMap<string, string | null>,
  opened?: readonly CollectionDoc[],
): Promise<BatchUpdateResult | null> {
  const ids = [...inputIds];
  const revisions = expectedRevisions && new Map(expectedRevisions);
  const snapshots = new Map(opened?.map((row) => [row._id, { ...row }]));
  const batch = createPublicationBatch();
  const snapshot = batch.journal.read();
  if (snapshot.problems.length)
    throw new AdminApiError(
      'RECOVERY_STORAGE_UNAVAILABLE',
      'Restore browser recovery storage before publishing. No new publication request was sent.',
    );
  const rows = new Map<string, CollectionDoc>();
  const failures = new Map<string, BatchUpdateFailure>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (!id) continue;
        try {
          batch.assertCurrent();
          const selected = snapshots.get(id);
          const hasPending = snapshot.entries.some((entry) => entry.scope.productId === id);
          const row =
            !selected || (selected.published === true && !hasPending)
              ? await getRecord('products', id, AbortSignal.timeout(8000))
              : selected;
          batch.assertCurrent();
          if (row._id !== id)
            throw new AdminApiError(
              'INVALID_RESPONSE',
              'The product did not match the selected row.',
            );
          rows.set(id, row);
        } catch (error) {
          failures.set(id, failure(id, error));
        }
      }
    }),
  );
  batch.assertCurrent();
  const saved = snapshot.entries.filter((entry) => ids.includes(entry.scope.productId));
  // Pending edits on an already published row require the existing live-refresh workflow.
  // Draft publication and unchanged live rows use the owned protocol below.
  if (
    [...rows.values()].some(
      (row) =>
        row.published === true &&
        row.alibabaReviewPending === true &&
        !saved.some((entry) => entry.scope.productId === row._id),
    )
  ) {
    if (saved.length)
      throw new AdminApiError(
        'BUSY',
        'Recover the original publications before publishing a selection with live edits.',
      );
    return null;
  }
  const entries: BatchEntry[] = [];
  const unchanged: CollectionDoc[] = [];
  const extraPointers: PublicationCheckpoint[] = [];
  for (const id of ids) {
    const originals = saved.filter((entry) => entry.scope.productId === id);
    if (originals.length > 1) {
      extraPointers.push(...originals);
      failures.set(
        id,
        failure(
          id,
          new AdminApiError(
            'BUSY',
            'This product has multiple original publications. Check or stop each original task before publishing.',
          ),
        ),
      );
      continue;
    }
    if (originals[0]) {
      failures.delete(id);
      entries.push(originals[0]);
      continue;
    }
    const row = rows.get(id);
    if (!row || failures.has(id)) continue;
    try {
      if (row.archived === true)
        throw new AdminApiError(
          'INVALID_PRODUCT',
          'Restore this product as a draft before publishing.',
        );
      if (['Changed', 'Removed'].includes(String(reviewLabel(row))))
        throw new AdminApiError(
          'INVALID_PRODUCT',
          'Review this product’s Alibaba changes in Edit before publishing.',
        );
      if (!isProductFamily(row.productFamily))
        throw new AdminApiError('INVALID_PRODUCT', 'Choose a website category before publishing.');
      const revision = revisions?.get(id) ?? row.updatedAt ?? null;
      if (revisions?.has(id) && (row.updatedAt ?? null) !== revisions.get(id))
        throw new AdminApiError(
          'CONFLICT',
          'The selected product changed. Refresh and review it before publishing.',
        );
      if (row.published === true) {
        const current = row;
        batch.assertCurrent();
        if (
          current.published !== true ||
          current.archived === true ||
          (current.updatedAt ?? null) !== revision ||
          current.alibabaReviewPending === true
        )
          throw new AdminApiError(
            'CONFLICT',
            'The published product changed. Refresh and review it before publishing.',
          );
        unchanged.push(current);
      } else
        entries.push(
          createPublicationAttempt({ productId: id, expectedUpdatedAt: revision, values: {} }),
        );
    } catch (error) {
      failures.set(id, failure(id, error));
    }
  }
  // Persist all captured IDs, including queued work, before the first write can be sent.
  for (const entry of entries) {
    batch.assertCurrent();
    if (batch.journal.retain(pointer(entry)).durability !== 'persistent')
      throw new AdminApiError(
        'RECOVERY_STORAGE_UNAVAILABLE',
        'Allow browser recovery storage before publishing. No publication requests were sent.',
      );
  }
  const result = entries.length
    ? await run(batch, entries, 'continue')
    : { updated: 0, items: [], failures: [], publication: { owner: batch.owner, checkpoints: [] } };
  const byId = new Map([...failures, ...result.failures.map((item) => [item.id, item] as const)]);
  return {
    ...result,
    failures: ids.flatMap((id) => byId.get(id) ?? []),
    unchanged,
    publication: {
      owner: batch.owner,
      checkpoints: [...result.publication.checkpoints, ...extraPointers],
    },
  };
}

/** Check, continue or stop only the tasks captured by the original selection. */
export async function recoverTablePublication(
  previous: BatchUpdateResult,
  ids: readonly string[],
  mode: 'continue' | 'check' | 'cancel',
): Promise<BatchUpdateResult> {
  const original = previous.publication;
  if (!original)
    throw new AdminApiError(
      'RECOVERY_MISSING',
      'The original publication record is missing. Refresh and review the products before publishing.',
    );
  const batch = createPublicationBatch();
  if (
    batch.owner.actorId !== original.owner.actorId ||
    batch.owner.endpoint !== original.owner.endpoint
  )
    throw new AdminApiError(
      'UNAUTHORIZED',
      'Return to the original account and environment to recover these publications.',
    );
  const wanted = new Set(ids);
  const entries = original.checkpoints.filter((entry) => wanted.has(entry.scope.productId));
  if (!entries.length) return previous;
  const result = await run(batch, entries, mode);
  const handled = new Set(entries.map((entry) => entry.scope.productId));
  const items = [
    ...new Map([...previous.items, ...result.items].map((item) => [item._id, item])).values(),
  ];
  return {
    updated: items.length,
    items,
    failures: [...previous.failures.filter((item) => !handled.has(item.id)), ...result.failures],
    ...(previous.unchanged ? { unchanged: previous.unchanged } : {}),
    publication: {
      owner: original.owner,
      checkpoints: [
        ...original.checkpoints.filter((entry) => !handled.has(entry.scope.productId)),
        ...result.publication.checkpoints,
      ],
    },
  };
}

export class TablePublicationError extends AdminApiError {
  constructor(readonly result: BatchUpdateResult) {
    const first = result.failures[0];
    super(
      first?.code ?? 'OPERATION_UNCONFIRMED',
      first?.message ?? 'Publication is not confirmed. Check its original task.',
    );
  }
}

/** A status toggle needs the confirmed identity/status; the list reloads the editable fields. */
export async function publishTableProduct(opened: CollectionDoc): Promise<CollectionDoc> {
  const result = await publishTableSelection(
    [opened._id],
    new Map([[opened._id, opened.updatedAt ?? null]]),
    [opened],
  );
  if (!result)
    throw new AdminApiError('CONFLICT', 'Review this live product in Edit before publishing.');
  const item = result.items[0];
  if (result.updated === 1 && item) return { ...item, published: true };
  const unchanged = result.unchanged?.[0];
  if (unchanged && !result.failures.length) return unchanged;
  throw new TablePublicationError(result);
}

/** A matching product is insufficient: recovery may update only the original owned scopes. */
export function mergeTablePublication(
  previous: BatchUpdateResult,
  next: BatchUpdateResult,
  selected: readonly PublicationCheckpoint[],
): BatchUpdateResult {
  if (
    !previous.publication ||
    !next.publication ||
    previous.publication.owner.actorId !== next.publication.owner.actorId ||
    previous.publication.owner.endpoint !== next.publication.owner.endpoint
  )
    return previous;
  const key = (entry: PublicationCheckpoint) =>
    JSON.stringify([entry.scope.productId, entry.scope.operationId]);
  const handled = previous.publication.checkpoints.filter((entry) =>
    selected.some(
      (value) =>
        key(value) === key(entry) &&
        (entry.scope.inputDigest === undefined ||
          value.scope.inputDigest === entry.scope.inputDigest),
    ),
  );
  if (!handled.length) return previous;
  const keys = new Set(handled.map(key));
  const ids = new Set(handled.map((entry) => entry.scope.productId));
  const items = [
    ...new Map(
      [...previous.items, ...next.items.filter((item) => ids.has(item._id))].map((item) => [
        item._id,
        item,
      ]),
    ).values(),
  ];
  const confirmed = new Set(items.map((item) => item._id));
  return {
    ...previous,
    updated: items.length,
    items,
    failures: [
      ...previous.failures.filter((item) => !ids.has(item.id)),
      ...next.failures.filter((item) => ids.has(item.id)),
    ].filter((item) => !confirmed.has(item.id)),
    publication: {
      owner: previous.publication.owner,
      checkpoints: [
        ...previous.publication.checkpoints.filter((entry) => !keys.has(key(entry))),
        ...next.publication.checkpoints.filter((entry) => keys.has(key(entry))),
      ],
    },
  };
}
