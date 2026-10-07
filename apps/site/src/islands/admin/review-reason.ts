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
