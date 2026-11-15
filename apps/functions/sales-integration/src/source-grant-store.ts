import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import { createCatalogTransactionReads } from '@vibelingan-channel/db/cloudbase-transaction-reads';
import {
  assertSalesSdkWrite,
  normalizeSalesSdkDocument,
} from '@vibelingan-channel/db/sales-inquiry-read';
import type { SourceGrantStore } from './source-grants.ts';

/** node-sdk 3.17.2 runTransaction returns the callback result; doc.set is flat data. */
export function createCloudBaseSourceGrantStore(db: NodeSdkDatabase): SourceGrantStore {
  return {
    transaction: (operation) =>
      db.runTransaction(async (transaction) => {
        let writing = false;
        // The native transaction already fixes a snapshot; repeated gates reuse its rows.
        const reads = createCatalogTransactionReads(async (collection, id) =>
          normalizeSalesSdkDocument(await transaction.collection(collection).doc(id).get(), id),
        );
        return operation({
          read: async (collection, id) => {
            if (writing) throw new Error('Source grant transaction read after write');
            return reads.get(collection, id);
          },
          write: async (collection, id, data) => {
            if (Object.hasOwn(data, '_id'))
              throw new Error('Source grant data contains document id');
            writing = true;
            reads.beforeWrite();
            assertSalesSdkWrite(await transaction.collection(collection).doc(id).set(data), id);
          },
        });
      }),
  };
}
