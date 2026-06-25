import {
  type CollectionDoc,
  type FilterClause,
  type ListResult,
  getCollection,
} from '@vibelingan-channel/shared';
/**
 * CloudBase (wx-server-sdk) implementation of `DbAdapter`.
 *
 * Used in production cloud functions. Call `initCloudBase(envId)` once at module
 * load before the adapter is used.
 */
import cloud from 'wx-server-sdk';
import type { Command, Database } from 'wx-server-sdk';
import type { DbAdapter } from './adapter.ts';

let initialized = false;

export function initCloudBase(envId: string): void {
  if (initialized) return;
  cloud.init({ env: envId });
  initialized = true;
}

function database() {
  if (!initialized) {
    throw new Error(
      '@vibelingan-channel/db: initCloudBase(envId) must be called before using the database',
    );
  }
  return cloud.database();
}

function normalize(raw: Record<string, unknown>): CollectionDoc {
  return raw as CollectionDoc;
}

function normalizeSingle(raw: unknown): CollectionDoc | null {
  const doc = Array.isArray(raw) ? raw[0] : raw;
  return doc && typeof doc === 'object' && !Array.isArray(doc)
    ? normalize(doc as Record<string, unknown>)
    : null;
}

export const cloudBaseAdapter: DbAdapter = {
  async list(query): Promise<ListResult<CollectionDoc>> {
    const db = database();
    const def = getCollection(query.collection);
    const collection = db.collection(query.collection);
    const _ = db.command;

    const ands: Record<string, unknown>[] = [];

    // Free-text search across the collection's searchable fields.
    if (query.search && def && def.searchableFields.length > 0) {
      const term = db.RegExp({ regexp: escapeRegExp(query.search), options: 'i' });
      ands.push(_.or(def.searchableFields.map((field) => ({ [field]: term }))));
    }

    // Structured filter (field/operator/value clauses combined with AND/OR).
    if (query.filter && query.filter.clauses.length > 0) {
      const clauseWheres = query.filter.clauses
        .map((c) => clauseToWhere(db, _, c))
        .filter((w): w is Record<string, unknown> => w !== null);
      if (clauseWheres.length > 0) {
        ands.push(query.filter.combinator === 'or' ? _.or(clauseWheres) : _.and(clauseWheres));
      }
    }

    const where = ands.length === 0 ? undefined : ands.length === 1 ? ands[0] : _.and(ands);

    const base = where ? collection.where(where) : collection;
    const countRes = await base.count();
    const total = countRes.total ?? 0;

    // Apply sort (default: newest first), then page.
    let q = base;
    const sort =
      query.sort && query.sort.length > 0
        ? query.sort
        : [{ field: 'createdAt', dir: 'desc' as const }];
    for (const s of sort) {
      q = q.orderBy(s.field, s.dir);
    }

    const skip = (query.page - 1) * query.pageSize;
    const res = await q.skip(skip).limit(query.pageSize).get();

    return {
      items: (res.data as Record<string, unknown>[]).map(normalize),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  },

  async get(collection, id): Promise<CollectionDoc | null> {
    const db = database();
    try {
      const res = await db.collection(collection).doc(id).get();
      return normalizeSingle(res.data);
    } catch {
      return null;
    }
  },

  async findByField(collection, field, value): Promise<CollectionDoc | null> {
    const db = database();
    const res = await db
      .collection(collection)
      .where({ [field]: value })
      .limit(1)
      .get();
    const raw = (res.data as Record<string, unknown>[])[0];
    return raw ? normalize(raw) : null;
  },

  async create(collection, data): Promise<CollectionDoc> {
    const db = database();
    const now = new Date().toISOString();
    const doc = { ...data, createdAt: now, updatedAt: now };
    const res = await db.collection(collection).add({ data: doc });
    return normalize({ _id: res._id as string, ...doc });
  },

  async update(collection, id, data): Promise<CollectionDoc | null> {
    const db = database();
    const patch = { ...data, updatedAt: new Date().toISOString() };
    await db.collection(collection).doc(id).update({ data: patch });
    return this.get(collection, id);
  },

  async remove(collection, id): Promise<boolean> {
    const db = database();
    const res = await db.collection(collection).doc(id).remove();
    return (res.deleted ?? 0) > 0;
  },
};

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate one filter clause into a wx-server-sdk `where` fragment. */
function clauseToWhere(
  db: Database,
  _: Command,
  clause: FilterClause,
): Record<string, unknown> | null {
  const { field, op, value } = clause;
  switch (op) {
    case 'eq':
      return { [field]: _.eq(value) };
    case 'ne':
      return { [field]: _.neq(value) };
    case 'contains':
      return { [field]: db.RegExp({ regexp: escapeRegExp(String(value ?? '')), options: 'i' }) };
    case 'startsWith':
      return {
        [field]: db.RegExp({ regexp: `^${escapeRegExp(String(value ?? ''))}`, options: 'i' }),
      };
    case 'gt':
      return { [field]: _.gt(value) };
    case 'gte':
      return { [field]: _.gte(value) };
    case 'lt':
      return { [field]: _.lt(value) };
    case 'lte':
      return { [field]: _.lte(value) };
    case 'in':
      return { [field]: _.in(Array.isArray(value) ? value : [value]) };
    case 'isEmpty':
      return { [field]: _.in(['', null]) };
    case 'isNotEmpty':
      return { [field]: _.nin(['', null]) };
    default:
      return null;
  }
}
