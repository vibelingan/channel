/**
 * Repository facade. Backend code (cloud functions, local-server) imports these
 * functions and never touches a concrete database. The active `DbAdapter` is
 * injected via `setAdapter` at startup.
 */
import {
  type CollectionDoc,
  type ListQuery,
  type ListResult,
  PUBLIC_CATALOG_COLLECTIONS,
  type SortClause,
  buildWriteSchema,
  getCollection,
  normalizeCatalogImageIds,
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
  // The delta feeds CloudBase db.command.inc and the local read-modify-write
  // path directly. A non-finite or fractional delta (NaN/Infinity/0.5) would
  // poison the counter — and since publishedRefCount gates public visibility,
  // a NaN silently hides the image (NaN > 0 === false). Guard the one choke
  // point so counters stay integral.
  if (!Number.isInteger(delta)) {
    throw new Error(
      `@vibelingan-channel/db: incrementField delta must be a finite integer (got ${delta}).`,
    );
  }
  return db().incrementField(collection, id, field, delta);
}

/**
 * Compute the next value of an atomic numeric counter for the read-modify-write
 * adapters (local JSON + in-memory test fakes), mirroring CloudBase
 * `db.command.inc` semantics: an absent/null field initialises from 0, while an
 * existing value that is not a finite number is a corruption error — CloudBase's
 * `$inc` likewise rejects a non-numeric field, so the local path must not
 * silently coerce it to 0 and diverge. `delta` is assumed already validated
 * (finite integer) by `incrementField`.
 */
export function nextCounterValue(current: unknown, delta: number): number {
  if (current === undefined || current === null) return delta;
  if (typeof current === 'number' && Number.isFinite(current)) return current + delta;
  throw new Error(
    `@vibelingan-channel/db: cannot increment a non-numeric counter value (got ${typeof current}).`,
  );
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

/**
 * Remove many documents by id. Returns the ids actually removed (each at most
 * once — a repeated or already-gone id is reported only on the call that
 * deleted it). Callers that maintain derived state (e.g. publishedRefCount) can
 * thus apply side effects for exactly the deletes that happened, not for ids
 * they merely intended to delete.
 */
export async function batchRemove(collection: string, ids: string[]): Promise<string[]> {
  assertKnown(collection);
  const removed: string[] = [];
  for (const id of ids) {
    if (await db().remove(collection, id)) {
      removed.push(id);
    }
  }
  return removed;
}

const BACKFILL_PAGE_SIZE = 100;

// Page by the unique `_id` so skip/limit pagination has a TOTAL order. The
// default sort (createdAt desc) ties for bulk-seeded/migrated rows, and CloudBase
// (Mongo-style skip/limit) can then skip or duplicate a tied row across a page
// boundary — which would corrupt the absolute counter this backfill writes. `_id`
// is unique, so paging is skip/duplicate-free. Order is irrelevant to the tally.
const STABLE_PAGE_SORT: SortClause[] = [{ field: '_id', dir: 'asc' }];

export interface BackfillRefCountsReport {
  dryRun: boolean;
  imagesScanned: number;
  changes: { imageId: string; from: number | null; to: number }[];
}

/**
 * recompute `images.publishedRefCount` from the current public catalog: for each
 * image, the number of PUBLISHED products/overstock documents that reference it.
 * Scope comes from `PUBLIC_CATALOG_COLLECTIONS`, shared with routing and online
 * counter maintenance. Every image's counter is set to
 * its tally (0 when unreferenced); duplicate ids within one document count once.
 *
 * This is the canonical reconciliation for MIU-04 (design §20.6 step 5): it
 * repairs drift from the non-transactional maintenance path and initialises rows
 * that never went through it (e.g. seeded data). With `dryRun`, it computes and
 * reports the changes without writing. Runs against whatever adapter is wired,
 * so it serves both the local seed and a deployed (CloudBase) invocation.
 *
 * Run during a quiescent window: it writes ABSOLUTE counts, so a live increment
 * (Phase B maintenance) landing between this function's read and its write can be
 * transiently clobbered — re-run to reconcile. Not a concern for the local seed
 * or a one-shot admin maintenance call.
 */
export async function backfillPublishedRefCounts(
  opts: { dryRun?: boolean } = {},
): Promise<BackfillRefCountsReport> {
  const dryRun = opts.dryRun ?? false;
  const catalogCollections = PUBLIC_CATALOG_COLLECTIONS;

  // Tally published references per image id.
  const counts = new Map<string, number>();
  for (const collection of catalogCollections) {
    let page = 1;
    for (;;) {
      const res = await list({
        collection,
        page,
        pageSize: BACKFILL_PAGE_SIZE,
        search: '',
        filter: { combinator: 'and', clauses: [{ field: 'published', op: 'eq', value: true }] },
        sort: STABLE_PAGE_SORT,
      });
      for (const doc of res.items) {
        const ids = new Set(normalizeCatalogImageIds(doc.imageIds));
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      if (res.items.length === 0 || page * res.pageSize >= res.total) break;
      page += 1;
    }
  }

  // Set every image's counter to its tally.
  const changes: BackfillRefCountsReport['changes'] = [];
  let imagesScanned = 0;
  let page = 1;
  for (;;) {
    const res = await list({
      collection: 'images',
      page,
      pageSize: BACKFILL_PAGE_SIZE,
      search: '',
      sort: STABLE_PAGE_SORT,
    });
    for (const image of res.items) {
      imagesScanned += 1;
      const id = String(image._id);
      const to = counts.get(id) ?? 0;
      const from = typeof image.publishedRefCount === 'number' ? image.publishedRefCount : null;
      if (from !== to) {
        changes.push({ imageId: id, from, to });
        if (!dryRun) await updateDoc('images', id, { publishedRefCount: to });
      }
    }
    if (res.items.length === 0 || page * res.pageSize >= res.total) break;
    page += 1;
  }

  return { dryRun, imagesScanned, changes };
}
