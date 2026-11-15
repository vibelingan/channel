import type { CollectionDoc } from '@vibelingan-channel/shared';
import type { CatalogSeoReadStore, CatalogSeoStore } from './catalog-seo-consumer.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';
import { assertDocumentWrite, sdkAnswer } from './cloudbase-sdk-answer.ts';

interface Query {
  orderBy(field: string, direction: 'asc' | 'desc'): Query;
  limit(count: number): Query;
  field(fields: Record<string, number>): Query;
  get(): Promise<unknown>;
}
export interface CatalogSeoDatabase extends NodeSdkDatabase {
  command: NodeSdkDatabase['command'] & { gt(value: string): unknown };
  collection(name: string): {
    doc(id: string): { get(): Promise<unknown> };
    where(filter: Record<string, unknown>): Query;
  };
}
const variantFields = Object.fromEntries(
  [
    '_id',
    'productId',
    'archived',
    'variantId',
    'position',
    'sku',
    'optionValues',
    'inventoryState',
    'inventoryQuantity',
    'catalogDetailRevision',
    'catalogDetailPosition',
    'catalogDetailApproved',
  ].map((key) => [key, 1]),
);
const familyFields = Object.fromEntries(
  ['_id', 'published', 'archived', 'productFamily', 'category'].map((key) => [key, 1]),
);

/** Management is not used: all reads and writes use the installed application Node SDK. */
export function createCatalogSeoStore(db: CatalogSeoDatabase): CatalogSeoStore {
  const get: CatalogSeoReadStore['get'] = async (collection, id) => {
    const value = answer(await db.collection(collection).doc(id).get());
    const row = Array.isArray(value) ? value[0] : value;
    return row == null ? null : document(row, id);
  };
  return {
    get,
    list: async (collection, filter, cursor, limit) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw Error('Invalid SEO page limit');
      let query = db
        .collection(collection)
        .where({ ...filter, ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
        .orderBy('_id', 'asc')
        .limit(limit);
      if (['productVariants', 'catalogDetailVariants'].includes(collection))
        query = query.field(variantFields);
      if (collection === 'products') query = query.field(familyFields);
      const rows = answer(await query.get());
      if (!Array.isArray(rows)) throw Error('SEO page response is not an array');
      return rows.map((row) => document(row));
    },
    transaction: (fn) =>
      db.runTransaction((tx) =>
        fn({
          get: async (collection, id) => {
            const value = answer(await tx.collection(collection).doc(id).get());
            const row = Array.isArray(value) ? value[0] : value;
            return row == null ? null : document(row, id);
          },
          set: async (collection, row) => {
            const { _id, ...data } = row;
            assertDocumentWrite(await tx.collection(collection).doc(_id).set(data), _id, 'set');
          },
        }),
      ),
  };
}

function answer(value: unknown): unknown {
  const result = sdkAnswer(value);
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'data'))
    throw Error('Missing SEO SDK response data');
  return Reflect.get(result, 'data');
}
function document(value: unknown, expectedId?: string): CollectionDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Malformed SEO document');
  const id = Reflect.get(value, '_id');
  if (typeof id !== 'string' || !id || (expectedId !== undefined && id !== expectedId))
    throw Error('Malformed SEO document identity');
  return { ...value, _id: id };
}
