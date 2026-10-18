/** Read images and every terminal proof through the same transaction snapshot. */
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
export const CATALOG_IMAGE_REFERENCE_LEDGER_FIELD = 'catalogPublishedReferenceLedger';
const ledgerField = CATALOG_IMAGE_REFERENCE_LEDGER_FIELD;
const proofsCollection = 'catalogDetailApprovals';

/** A valid empty ledger and its base are already one image snapshot; null means proofs need a transaction. */
export function emptyCatalogImageReferenceCount(image: CollectionDoc): number | null {
  if (!Object.hasOwn(image, 'publishedRefCount'))
    throw new CatalogImageReferenceError('INVALID_COUNT');
  const ledger = image[ledgerField];
  if (ledger === undefined) throw new CatalogImageReferenceError('INVALID_LEDGER');
  if (catalogImageReferenceProofIds(image._id, ledger).length > 0) return null;
  return planImageReferenceSettlement(image._id, image.publishedRefCount, ledger, new Map())
    .effectiveCount;
}

export const CatalogImageReferenceIncrementSchema = CatalogImageReferenceReadSchema.omit({
  action: true,
})
  .extend({ delta: z.number().int().safe() })
  .strict();
export type CatalogImageReferenceIncrementCommand = z.input<
  typeof CatalogImageReferenceIncrementSchema
>;

/** Caller owns one transaction or one JSON mutation lock; no nested snapshot or external IO. */
export async function runCatalogImageReferenceRead(
  tx: CatalogImageReferenceStore,
  input: unknown,
): Promise<CatalogImageReferenceSnapshot> {
  const command = CatalogImageReferenceReadSchema.parse(input);
  const loaded = await loadImageReferences(
    tx,
    command,
    command.action === 'settle' ? 'settle' : false,
  );
  if (loaded.snapshot.state !== 'counted' || !loaded.settlement || command.action !== 'settle')
    return loaded.snapshot;
  await tx.set('images', loaded.settlement);
  return { ...loaded.snapshot, image: loaded.settlement, settled: true };
}

/** Merge old counter maintenance and all resolved proofs in one image write. Legacy absence stays unknown. */
export async function runCatalogImageReferenceIncrement(
  tx: CatalogImageReferenceStore,
  input: unknown,
  now = new Date().toISOString(),
): Promise<number | null> {
  const command = CatalogImageReferenceIncrementSchema.parse(input);
  const loaded = await loadImageReferences(tx, command, command.delta === 0 ? 'settle' : 'adjust');
  if (loaded.snapshot.state !== 'counted') return null;
  const next = loaded.snapshot.effectiveCount + command.delta;
  if (!Number.isSafeInteger(next) || next < 0)
    throw new CatalogImageReferenceError('INVALID_COUNT');
  if (command.delta === 0 && !loaded.settlement) return next;
  await tx.set('images', {
    ...(loaded.settlement ?? loaded.snapshot.image),
    publishedRefCount: next,
    updatedAt: now,
  });
  return next;
}

type LoadedImageReferences = {
  snapshot: CatalogImageReferenceSnapshot;
  settlement: CollectionDoc | null;
};
async function loadImageReferences(
  tx: CatalogImageReferenceStore,
  command: { imageId: string; maxDocumentOperations: number },
  write: 'settle' | 'adjust' | false,
): Promise<LoadedImageReferences> {
  const image = await tx.get('images', command.imageId);
  if (image === undefined) throw new CatalogImageReferenceError('MISSING_SNAPSHOT_READ');
  if (image === null)
    return {
      snapshot: { state: 'missing', imageId: command.imageId, documentReads: 1, settled: false },
      settlement: null,
    };
  if (image._id !== command.imageId) throw new CatalogImageReferenceError('INVALID_LEDGER');
  const hasLedger = Object.hasOwn(image, ledgerField);
  if (!Object.hasOwn(image, 'publishedRefCount')) {
    if (hasLedger) throw new CatalogImageReferenceError('INVALID_COUNT');
    return {
      snapshot: { state: 'legacy', image, documentReads: 1, settled: false },
      settlement: null,
    };
  }
  // Validate the base before fetching any proofs; an absent ledger grants no delta.
  planImageReferenceSettlement(command.imageId, image.publishedRefCount, undefined, new Map());
  if (hasLedger && image[ledgerField] === undefined)
    throw new CatalogImageReferenceError('INVALID_LEDGER');
  const proofIds = catalogImageReferenceProofIds(command.imageId, image[ledgerField]);
  const documentReads = 1 + proofIds.length;
  const writeAllowance = write === 'adjust' || (write === 'settle' && proofIds.length > 0) ? 1 : 0;
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
  return {
    snapshot: {
      state: 'counted',
      image,
      effectiveCount: plan.effectiveCount,
      documentReads,
      settled: false,
    },
    settlement: plan.settlement
      ? {
          ...image,
          publishedRefCount: plan.settlement.publishedRefCount,
          [ledgerField]: plan.settlement.ledger,
        }
      : null,
  };
}
