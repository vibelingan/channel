/** Read images and every commit proof through the same transaction snapshot. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import {
  CatalogImageReferenceError,
  catalogImageReferenceProofIds,
  planImageReferenceSettlement,
} from './catalog-image-references.ts';

export const CatalogImageReferenceReadSchema = z
  .object({
    action: z.enum(['read', 'settle']),
    imageId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    maxDocumentOperations: z.number().int().min(1).max(98).default(98),
  })
  .strict();
export type CatalogImageReferenceReadCommand = z.input<typeof CatalogImageReferenceReadSchema>;
export type CatalogImageReferenceSnapshot =
  | { state: 'missing'; imageId: string; documentReads: number; settled: false }
  | { state: 'legacy'; image: CollectionDoc; documentReads: number; settled: false }
  | {
      state: 'counted';
      image: CollectionDoc;
      effectiveCount: number;
      documentReads: number;
      settled: boolean;
    };
export interface CatalogImageReferenceStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  set(collection: 'images', row: CollectionDoc): Promise<void>;
}
const ledgerField = 'catalogPublishedReferenceLedger';
const proofsCollection = 'catalogDetailApprovals';

/** Caller owns one transaction or one JSON mutation lock; no nested snapshot or external IO. */
export async function runCatalogImageReferenceRead(
  tx: CatalogImageReferenceStore,
  input: unknown,
): Promise<CatalogImageReferenceSnapshot> {
  const command = CatalogImageReferenceReadSchema.parse(input);
  const image = await tx.get('images', command.imageId);
  if (image === undefined) throw new CatalogImageReferenceError('MISSING_SNAPSHOT_READ');
  if (image === null)
    return { state: 'missing', imageId: command.imageId, documentReads: 1, settled: false };
  if (image._id !== command.imageId) throw new CatalogImageReferenceError('INVALID_LEDGER');
  const hasLedger = Object.hasOwn(image, ledgerField);
  if (!Object.hasOwn(image, 'publishedRefCount')) {
    if (hasLedger) throw new CatalogImageReferenceError('INVALID_COUNT');
    return { state: 'legacy', image, documentReads: 1, settled: false };
  }
  // Validate the base before fetching any proofs; an absent ledger grants no delta.
  planImageReferenceSettlement(command.imageId, image.publishedRefCount, undefined, new Map());
  if (hasLedger && image[ledgerField] === undefined)
    throw new CatalogImageReferenceError('INVALID_LEDGER');
  const proofIds = catalogImageReferenceProofIds(command.imageId, image[ledgerField]);
  const documentReads = 1 + proofIds.length;
  const writeAllowance = command.action === 'settle' && proofIds.length > 0 ? 1 : 0;
  if (documentReads + writeAllowance > command.maxDocumentOperations)
    throw new CatalogImageReferenceError('DOCUMENT_BUDGET_EXCEEDED');
  const proofs = new Map<string, CollectionDoc | null>();
  for (let offset = 0; offset < proofIds.length; offset += 4) {
    const batch = proofIds.slice(offset, offset + 4);
    const rows = await Promise.allSettled(batch.map((id) => tx.get(proofsCollection, id)));
    for (const [index, id] of batch.entries()) {
      const row = rows[index];
      if (!row) throw new CatalogImageReferenceError('MISSING_SNAPSHOT_READ');
      if (row.status === 'rejected') throw row.reason;
      if (row.value === undefined) throw new CatalogImageReferenceError('MISSING_SNAPSHOT_READ');
      proofs.set(id, row.value);
    }
  }
  const plan = planImageReferenceSettlement(
    command.imageId,
    image.publishedRefCount,
    image[ledgerField],
    proofs,
  );
  let current = image;
  const settled = command.action === 'settle' && plan.settlement !== null;
  if (settled && plan.settlement) {
    current = {
      ...image,
      publishedRefCount: plan.settlement.publishedRefCount,
      [ledgerField]: plan.settlement.ledger,
    };
    await tx.set('images', current);
  }
  return {
    state: 'counted',
    image: current,
    effectiveCount: plan.effectiveCount,
    documentReads,
    settled,
  };
}
