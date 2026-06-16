import { type CollectionDoc, type ListResult, getCollection } from '@vibelingan-channel/shared';
/**
 * CloudBase (wx-server-sdk) implementation of `DbAdapter`.
 *
 * Used in production cloud functions. Call `initCloudBase(envId)` once at module
 * load before the adapter is used.
 */
import cloud from 'wx-server-sdk';
import type { DbAdapter } from './adapter.ts';

let initialized = false;

export function initCloudBase(envId: string): void {
  if (initialized) return;
  cloud.init({ env: envId });
  initialized = true;
}

function database() {
  if (!initialized) {
    throw new Error('@vibelingan-channel/db: initCloudBase(envId) must be called before using the database');
  }
  return cloud.database();
}

function normalize(raw: Record<string, unknown>): CollectionDoc {
  return raw as CollectionDoc;
}

export const cloudBaseAdapter: DbAdapter = {
  async list(query): Promise<ListResult<CollectionDoc>> {
    const db = database();
    const def = getCollection(query.collection);
    const collection = db.collection(query.collection);

    let where: Record<string, unknown> | undefined;
    if (query.search && def && def.searchableFields.length > 0) {
      const _ = db.command;
      const term = db.RegExp({ regexp: escapeRegExp(query.search), options: 'i' });
      where = _.or(def.searchableFields.map((field) => ({ [field]: term })));
    }

    const base = where ? collection.where(where) : collection;
    const countRes = await (where ? collection.where(where) : collection).count();
    const total = countRes.total ?? 0;

    const skip = (query.page - 1) * query.pageSize;
    const res = await base.orderBy('createdAt', 'desc').skip(skip).limit(query.pageSize).get();

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
      const raw = (res.data as Record<string, unknown>[])[0];
      return raw ? normalize(raw) : null;
    } catch {
      return null;
    }
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
