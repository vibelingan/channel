import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import {
  normalizeSalesSdkDocument,
  assertSalesSdkWrite,
} from '@vibelingan-channel/db/sales-inquiry-read';
import type { DeliveryStore, DeliveryOwner } from './website-delivery.ts';

interface ScanQuery {
  orderBy(field: string, direction: 'asc' | 'desc'): ScanQuery;
  limit(count: number): ScanQuery;
  get(): Promise<unknown>;
}
/** The installed node-sdk query methods; no wx-server-sdk type shim is extended. */
export interface DeliveryDatabase extends Pick<NodeSdkDatabase, 'runTransaction'> {
  command: { gt(value: string): unknown; in(values: string[]): unknown };
  collection(name: string): { where(filters: Record<string, unknown>): ScanQuery };
}
const READ_COLLECTIONS = new Set([
  'channelSalesSourceRegistrations',
  'channelSalesSourceDeliveries',
  'channelSalesDeliveryCursors',
  'channelSalesBindings',
  'channelSalesInstallations',
  'oemProjects',
  'catalogQuoteRequests',
  'files',
]);
const WRITE_COLLECTIONS = new Set(['channelSalesSourceDeliveries', 'channelSalesDeliveryCursors']);
function validTarget(collection: string, id: string, writing: boolean): void {
  if (
    !(writing ? WRITE_COLLECTIONS : READ_COLLECTIONS).has(collection) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(id)
  )
    throw new Error('Invalid delivery storage target');
}
export function createDeliveryStore(db: DeliveryDatabase): DeliveryStore {
  return {
    transaction: (operation) =>
      db.runTransaction(async (transaction) => {
        let writing = false;
        return operation({
          read: async (collection, id) => {
            if (writing) throw new Error('Delivery transaction read after write');
            validTarget(collection, id, false);
            return normalizeSalesSdkDocument(
              await transaction.collection(collection).doc(id).get(),
              id,
            );
          },
          write: async (collection, id, data) => {
            validTarget(collection, id, true);
            if (Object.hasOwn(data, '_id')) throw new Error('Delivery data contains document id');
            writing = true;
            assertSalesSdkWrite(await transaction.collection(collection).doc(id).set(data), id);
          },
        });
      }),
    scan: async (owner: DeliveryOwner, after: string | null, limit: number) => {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (after !== null && !/^[a-f0-9]{64}$/.test(after))
      )
        throw new Error('Invalid delivery scan bounds');
      const filters: Record<string, unknown> = {
        'record.client_id': owner.client_id,
        'record.business_line': owner.business_line,
        'record.source_installation_id': owner.source_installation_id,
        'record.environment': owner.environment,
        'record.status': db.command.in(['pending', 'retry', 'inflight']),
        ...(after === null ? {} : { _id: db.command.gt(after) }),
      };
      const result = await db
        .collection('channelSalesSourceDeliveries')
        .where(filters)
        .orderBy('_id', 'asc')
        .limit(limit)
        .get();
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.hasOwn(result, 'code') ||
        Object.hasOwn(result, 'error') ||
        !Object.hasOwn(result, 'data')
      )
        throw new Error('Invalid delivery SDK scan result');
      const rows: unknown = Reflect.get(result, 'data');
      if (!Array.isArray(rows) || rows.length > limit)
        throw new Error('Invalid delivery SDK scan rows');
      return rows.map((row) => {
        if (
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          !Object.hasOwn(row, '_id') ||
          !Object.hasOwn(row, 'record')
        )
          throw new Error('Invalid delivery scan document');
        const key: unknown = Reflect.get(row, '_id');
        if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
          throw new Error('Invalid delivery scan identity');
        return { key, record: Reflect.get(row, 'record') };
      });
    },
  };
}
