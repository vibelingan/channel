import type { CollectionDoc } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';

export class CatalogPreparationPlanLimitError extends Error {
  constructor() {
    super('Preparation needs its original bounded steps');
  }
}

/** Plan only preparation metadata in one native snapshot; every actual read precedes every write. */
export function planCatalogPreparationTransaction(
  native: CatalogApprovalTransaction,
  initialJob: CollectionDoc,
) {
  const reads = new Map<string, { row: CollectionDoc | null; bytes: number }>();
  const writes = new Map<string, { collection: string; row: CollectionDoc; bytes: number }>();
  const key = (collection: string, id: string) => JSON.stringify([collection, id]);
  let bytes = 0;
  let readCalls = 1; // The caller already read the seeded job in this native transaction.
  let flushing = false;
  let failed: { error: unknown } | undefined;
  const abort = (error: unknown): never => {
    failed ??= { error };
    throw failed.error;
  };
  const capture = (row: CollectionDoc | null, replacing = 0) => {
    if (!fitsJsonBudget(row, Math.min(512 * 1024, 4 * 1024 * 1024 - bytes + replacing)))
      return abort(new CatalogPreparationPlanLimitError());
    try {
      const copy = structuredClone(row);
      return { row: copy, bytes: Buffer.byteLength(JSON.stringify(copy)) };
    } catch {
      return abort(new CatalogPreparationPlanLimitError());
    }
  };
  const seed = capture(initialJob);
  reads.set(key('catalogPreparationJobs', initialJob._id), seed);
  bytes += seed.bytes;
  const available = () => {
    if (failed) throw failed.error;
    if (flushing) throw Error('Preparation plan is already being committed');
    if (readCalls + writes.size > 98) abort(new CatalogPreparationPlanLimitError());
  };
  const tx: CatalogApprovalTransaction = {
    get: async (collection, id) => {
      available();
      const identity = key(collection, id);
      const cached = writes.get(identity) ?? reads.get(identity);
      if (cached) return structuredClone(cached.row);
      if (readCalls + writes.size >= 98) abort(new CatalogPreparationPlanLimitError());
      readCalls++;
      let row: CollectionDoc | null;
      try {
        row = await native.get(collection, id);
      } catch (error) {
        return abort(error);
      }
      const saved = capture(row);
      reads.set(identity, saved);
      bytes += saved.bytes;
      available();
      return row;
    },
    set: async (collection, row) => {
      available();
      const identity = key(collection, row._id);
      const previous = writes.get(identity);
      const saved = capture(row, previous?.bytes ?? 0);
      if (!saved.row) throw Error('Preparation cannot write a missing document');
      writes.set(identity, { collection, row: saved.row, bytes: saved.bytes });
      bytes += saved.bytes - (previous?.bytes ?? 0);
      available();
    },
  };
  return {
    tx,
    async flush(stillOwn: () => boolean) {
      available();
      if (!stillOwn()) abort(Error('Preparation lease changed before metadata commit'));
      flushing = true;
      for (const { collection, row } of writes.values()) {
        try {
          await native.set(collection, row);
        } catch (error) {
          return abort(error);
        }
        if (!stillOwn()) abort(Error('Preparation lease changed during metadata commit'));
      }
    },
  };
}
