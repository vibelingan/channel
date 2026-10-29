import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import type { SourceGrantStore } from './source-grants.ts';

/** node-sdk 3.17.2 runTransaction returns the callback result; doc.set is flat data. */
export function createCloudBaseSourceGrantStore(db: NodeSdkDatabase): SourceGrantStore {
  return {
    transaction: (operation) =>
      db.runTransaction(async (transaction) => {
        let writing = false;
        return operation({
          read: async (collection, id) => {
            if (writing) throw new Error('Source grant transaction read after write');
            const result: unknown = await transaction.collection(collection).doc(id).get();
            if (
              !result ||
              typeof result !== 'object' ||
              Array.isArray(result) ||
              !Object.hasOwn(result, 'data') ||
              Reflect.get(result, 'data') === undefined ||
              Object.hasOwn(result, 'code') ||
              Object.hasOwn(result, 'error')
            )
              throw new Error('Invalid source grant SDK read result');
            const rows: unknown = Reflect.get(result, 'data');
            if (Array.isArray(rows)) {
              if (rows.length > 1) throw new Error('Ambiguous source grant document');
              if (rows.length === 1 && rows[0] == null)
                throw new Error('Invalid source grant document');
            }
            const row: unknown = Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
            if (
              row !== null &&
              (typeof row !== 'object' ||
                Array.isArray(row) ||
                !Object.hasOwn(row, '_id') ||
                Reflect.get(row, '_id') !== id)
            ) {
              throw new Error('Invalid source grant document identity');
            }
            return row;
          },
          write: async (collection, id, data) => {
            if (Object.hasOwn(data, '_id'))
              throw new Error('Source grant data contains document id');
            writing = true;
            const acknowledgement = await transaction.collection(collection).doc(id).set(data);
            if (
              !acknowledgement ||
              typeof acknowledgement !== 'object' ||
              Array.isArray(acknowledgement) ||
              Object.hasOwn(acknowledgement, 'code') ||
              Object.hasOwn(acknowledgement, 'error')
            )
              throw new Error('Invalid source grant SDK write result');
            if (
              acknowledgement.updated !== 1 &&
              !acknowledgement.upserted?.some((row) => row._id === id)
            )
              throw new Error('Source grant write was not acknowledged');
          },
        });
      }),
  };
}
