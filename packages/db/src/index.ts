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

export type { DbAdapter } from './adapter.ts';

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
  });
}

export function get(collection: string, id: string): Promise<CollectionDoc | null> {
  assertKnown(collection);
  return db().get(collection, id);
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

export function remove(collection: string, id: string): Promise<boolean> {
  assertKnown(collection);
  return db().remove(collection, id);
}
