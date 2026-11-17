/** Request-local node-sdk read port for the existing approved product reader. */
import type { CloudBase } from '@cloudbase/node-sdk';
import { normalizeSalesSdkDocument } from '@vibelingan-channel/db/sales-inquiry-read';
import type { createApprovedProductReader } from '../../public-api/src/catalog-detail.ts';
export function createCatalogReadPort(
  database: ReturnType<CloudBase['database']>,
): Parameters<typeof createApprovedProductReader>[0] {
  return {
    async get(collection, id) {
      if (collection !== 'products') throw Error('Unexpected catalog collection');
      return normalizeSalesSdkDocument(await database.collection(collection).doc(id).get(), id);
    },
    async list(query) {
      const clauses = query.filter?.clauses;
      const product = clauses?.find((c) => c.field === 'productId');
      const revision = clauses?.find((c) => c.field === 'catalogDetailRevision');
      const archived = clauses?.find((c) => c.field === 'archived');
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 50;
      if (
        !['catalogDetailVariants', 'productVariants'].includes(query.collection) ||
        query.filter?.combinator !== 'and' ||
        clauses?.length !== 3 ||
        product?.op !== 'eq' ||
        typeof product.value !== 'string' ||
        revision?.op !== 'eq' ||
        typeof revision.value !== 'string' ||
        archived?.op !== 'ne' ||
        archived.value !== true ||
        JSON.stringify(query.sort) !==
          JSON.stringify([
            { field: 'catalogDetailPosition', dir: 'asc' },
            { field: '_id', dir: 'asc' },
          ]) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 50
      )
        throw Error('Unexpected approved catalog query');
      const rows = database.collection(query.collection).where({
        productId: product.value,
        catalogDetailRevision: revision.value,
        archived: database.command.neq(true),
      });
      const total = (await rows.count()).total;
      const answer = await rows
        .orderBy('catalogDetailPosition', 'asc')
        .orderBy('_id', 'asc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
      if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(answer.data))
        throw Error('Unconfirmed catalog rows');
      const items = answer.data.map((row: unknown) => {
        const id = row && typeof row === 'object' ? Reflect.get(row, '_id') : undefined;
        if (typeof id !== 'string' || !id) throw Error('Unconfirmed catalog row');
        const value = normalizeSalesSdkDocument({ data: row }, id);
        if (!value) throw Error('Unconfirmed catalog row');
        return value;
      });
      return { items, total, page, pageSize };
    },
  };
}
