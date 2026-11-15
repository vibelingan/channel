import type { CollectionDoc } from '@vibelingan-channel/shared';
import type { SalesSourceCollection } from './sales-inquiry-source.ts';
export type { SalesSourceCollection } from './sales-inquiry-source.ts';
export function normalizeSalesSdkDocument(result: unknown, id: string): CollectionDoc | null {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !Object.hasOwn(result, 'data') ||
    Reflect.get(result, 'data') === undefined ||
    Object.hasOwn(result, 'code') ||
    Object.hasOwn(result, 'error')
  )
    throw new Error('Invalid sales SDK read result');
  const rows: unknown = Reflect.get(result, 'data');
  if (Array.isArray(rows) && (rows.length > 1 || (rows.length === 1 && rows[0] == null)))
    throw new Error('Ambiguous sales SDK document');
  const row: unknown = Array.isArray(rows) ? (rows[0] ?? null) : rows;
  if (row === null) return null;
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    !Object.hasOwn(row, '_id') ||
    Reflect.get(row, '_id') !== id
  )
    throw new Error('Invalid sales document identity');
  return row as CollectionDoc;
}
export function assertSalesSdkWrite(result: unknown, id: string): void {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.hasOwn(result, 'code') ||
    Object.hasOwn(result, 'error')
  )
    throw new Error('Invalid sales SDK write result');
  const upserted: unknown = Reflect.get(result, 'upserted');
  if (
    Reflect.get(result, 'updated') !== 1 &&
    !(
      Array.isArray(upserted) &&
      upserted.some((row) => row && typeof row === 'object' && Reflect.get(row, '_id') === id)
    )
  )
    throw new Error('Sales SDK write not acknowledged');
}
export interface SalesReadDatabase {
  collection(name: string): { doc(id: string): { get(): Promise<unknown> } };
}
export async function readSalesSourceRecord(
  db: SalesReadDatabase,
  collection: SalesSourceCollection,
  id: string,
): Promise<CollectionDoc | null> {
  if (
    !['oemProjects', 'catalogQuoteRequests', 'files'].includes(collection) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(id)
  )
    throw new Error('Invalid sales source target');
  return normalizeSalesSdkDocument(await db.collection(collection).doc(id).get(), id);
}
