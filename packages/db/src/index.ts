/**
 * Repository facade. Backend code (cloud functions, local-server) imports these
 * functions and never touches a concrete database. The active `DbAdapter` is
 * injected via `setAdapter` at startup.
 */
import {
  type CollectionDoc,
  type ListQuery,
  type ListResult,
  buildWriteSchema,
  getCollection,
} from '@vibelingan-channel/shared';
import type { DbAdapter } from './adapter.ts';

export type { AdapterListQuery, DbAdapter } from './adapter.ts';

/**
 * The active adapter is stored on `globalThis` rather than a plain module
 * variable. Under pnpm, a package can be loaded as more than one module
 * instance (different symlink-resolved URLs), which would give each instance
 * its own singleton. Anchoring to `globalThis` keeps a single shared adapter
 * regardless of how many times this module is instantiated.
 */
const ADAPTER_KEY = Symbol.for('@vibelingan-channel/db.adapter');

type AdapterHost = { [ADAPTER_KEY]?: DbAdapter | null };

export function setAdapter(next: DbAdapter): void {
  (globalThis as AdapterHost)[ADAPTER_KEY] = next;
}

function db(): DbAdapter {
  const adapter = (globalThis as AdapterHost)[ADAPTER_KEY];
  if (!adapter) {
    throw new Error('@vibelingan-channel/db: no adapter configured. Call setAdapter() at startup.');
  }
  return adapter;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function assertKnown(collection: string) {
  const def = getCollection(collection);
  if (!def) {
    throw new UnknownCollectionError(collection);
  }
  return def;
}

export class UnknownCollectionError extends Error {
  constructor(public readonly collection: string) {
    super(`Unknown collection: ${collection}`);
    this.name = 'UnknownCollectionError';
  }
}

export async function list(query: ListQuery): Promise<ListResult<CollectionDoc>> {
  assertKnown(query.collection);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
  return db().list({
    collection: query.collection,
    page,
    pageSize,
    search: (query.search ?? '').trim(),
    ...(query.filter ? { filter: query.filter } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
  });
}

export function get(collection: string, id: string): Promise<CollectionDoc | null> {
  assertKnown(collection);
  return db().get(collection, id);
}

/** Find the first document where `field` exactly equals `value`. */
export function findByField(
  collection: string,
  field: string,
  value: unknown,
): Promise<CollectionDoc | null> {
  assertKnown(collection);
  return db().findByField(collection, field, value);
}

/** Validate `data` against the collection registry, then create the document. */
export function create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
  const def = assertKnown(collection);
  const parsed = buildWriteSchema(def).parse(data);
  return db().create(collection, parsed);
}

/** Validate a partial `data` against the registry, then update the document. */
export function update(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc | null> {
  const def = assertKnown(collection);
  const parsed = buildWriteSchema(def).partial().parse(data);
  return db().update(collection, id, parsed);
}

/**
 * Trusted, server-side write that bypasses the registry write-schema. Used by
 * the auth flow to set server-managed fields (e.g. `passwordHash`) that are
 * marked read-only for the generic admin CRUD.
 */
export function createDoc(
  collection: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc> {
  assertKnown(collection);
  return db().create(collection, data);
}

/** Trusted, server-side partial update that bypasses the registry write-schema. */
export function updateDoc(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc | null> {
  assertKnown(collection);
  return db().update(collection, id, data);
}

/**
 * Trusted, server-side atomic increment of one numeric field, bypassing the
 * registry write-schema. Used to maintain server-managed counters such as
 * `images.publishedRefCount` (read-only on the generic CRUD surface). Returns
 * the new value, or `null` if the document does not exist.
 */
export function incrementField(
  collection: string,
  id: string,
  field: string,
  delta: number,
): Promise<number | null> {
  assertKnown(collection);
  return db().incrementField(collection, id, field, delta);
}

export function remove(collection: string, id: string): Promise<boolean> {
  assertKnown(collection);
  return db().remove(collection, id);
}

/**
 * Apply the same partial update to many documents. Validated against the
 * registry write-schema once, then applied per id. Returns the updated docs.
 */
export async function batchUpdate(
  collection: string,
  ids: string[],
  data: Record<string, unknown>,
): Promise<CollectionDoc[]> {
  const def = assertKnown(collection);
  const parsed = buildWriteSchema(def).partial().parse(data);
  const results: CollectionDoc[] = [];
  for (const id of ids) {
    const updated = await db().update(collection, id, parsed);
    if (updated) {
      results.push(updated);
    }
  }
  return results;
}

/** Remove many documents by id. Returns the count actually removed. */
export async function batchRemove(collection: string, ids: string[]): Promise<number> {
  assertKnown(collection);
  let removed = 0;
  for (const id of ids) {
    if (await db().remove(collection, id)) {
      removed += 1;
    }
  }
  return removed;
}
