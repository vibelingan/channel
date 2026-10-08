import type { CollectionDoc } from '@vibelingan-channel/shared';

const LABELS = { new: 'New', changed: 'Changed', removed: 'Removed', edited: 'Edited' } as const;
export type ReviewLabel = (typeof LABELS)[keyof typeof LABELS];

/**
 * Why a product needs review, as admins read it (DEC-7). A pending row from
 * before reasons existed is "New"; a product that needs no review gets none.
 */
export function reviewLabel(doc: CollectionDoc): ReviewLabel | null {
  if (doc.alibabaReviewPending !== true) return null;
  const reason = doc.alibabaReviewReason;
  return typeof reason === 'string' && Object.hasOwn(LABELS, reason)
    ? LABELS[reason as keyof typeof LABELS]
    : 'New';
}

/**
 * A live product whose Alibaba data changed, or whose listing was removed,
 * since its approval. Saving or publishing it re-approves from the latest
 * data, so the admin is told before that happens (DEC-12). Drafts are not
 * included: Publish is their approval.
 */
export function pendingSupplierChange(doc: CollectionDoc): 'Changed' | 'Removed' | null {
  if (doc.published !== true) return null;
  const label = reviewLabel(doc);
  return label === 'Changed' || label === 'Removed' ? label : null;
}

export const PENDING_SUPPLIER_CHANGE_NOTICE = {
  Changed: 'Alibaba data changed since the last approval. Saving publishes these changes too.',
  Removed:
    'This product was removed on Alibaba since the last approval. Saving keeps it live with its last Alibaba data.',
} as const;

/** [products with pending Alibaba changes, the rest], each in the given order. */
export function splitPendingSupplierChanges(
  docs: readonly CollectionDoc[],
): [CollectionDoc[], CollectionDoc[]] {
  return [
    docs.filter((doc) => pendingSupplierChange(doc) !== null),
    docs.filter((doc) => pendingSupplierChange(doc) === null),
  ];
}
