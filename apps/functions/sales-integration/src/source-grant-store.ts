import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import type { SourceGrantStore } from './source-grants.ts';
import {
  normalizeSalesSdkDocument,
  assertSalesSdkWrite,
} from '@vibelingan-channel/db/sales-inquiry-read';

/** node-sdk 3.17.2 runTransaction returns the callback result; doc.set is flat data. */
export function createCloudBaseSourceGrantStore(db: NodeSdkDatabase): SourceGrantStore {
  return {
    transaction: (operation) =>
      db.runTransaction(async (transaction) => {
        let writing = false;
        return operation({
          read: async (collection, id) => {
            if (writing) throw new Error('Source grant transaction read after write');
            return normalizeSalesSdkDocument(
              await transaction.collection(collection).doc(id).get(),
              id,
            );
          },
          write: async (collection, id, data) => {
            if (Object.hasOwn(data, '_id'))
              throw new Error('Source grant data contains document id');
            writing = true;
            assertSalesSdkWrite(await transaction.collection(collection).doc(id).set(data), id);
          },
        });
      }),
  };
}
