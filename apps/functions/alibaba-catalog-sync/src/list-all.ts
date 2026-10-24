/**
 * Complete cursor walk over a collection (blessing-gate P1).
 *
 * `list()` SILENTLY clamps pageSize to MAX_PAGE_SIZE (100) — it returns no
 * truncation signal and echoes the clamped size back, so a caller asking for
 * 500 quietly receives at most 100 rows. Every call site that must see the
 * WHOLE set (promotion candidates, tombstone candidates, and the quarantine
 * recomputation that has to reproduce both byte-for-byte) goes through this
 * helper instead.
 *
 * The walk is `_id > cursor` ordered by `_id` ascending, matching the
 * never-skip pattern already used by the media reference scan: rows can be
 * created or removed concurrently, and an offset/limit scan can shift a
 * surviving row across a page boundary it has already passed.
 */
import { list } from '@vibelingan-channel/db';
import type { CollectionDoc, FilterModel } from '@vibelingan-channel/shared';

/** Matches the facade clamp; asking for more is silently reduced anyway. */
const PAGE_SIZE = 100;
/**
 * Hard stop so a pathological mirror cannot spin a 900s function forever.
 * Exceeding it throws rather than truncating: a short read here would corrupt
 * the candidate hash and silently drop products from a sync.
 */
const MAX_PAGES = 500;

export async function listAllDocs(
  collection: string,
  clauses: FilterModel['clauses'],
): Promise<CollectionDoc[]> {
  const out: CollectionDoc[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const filter: FilterModel = {
      combinator: 'and',
      clauses: cursor
        ? [...clauses, { field: '_id', op: 'gt' as const, value: cursor }]
        : [...clauses],
    };
    const result = await list({
      collection,
      page: 1,
      pageSize: PAGE_SIZE,
      search: '',
      sort: [{ field: '_id', dir: 'asc' as const }],
      filter,
    });
    out.push(...result.items);
    const last = result.items.at(-1);
    if (result.items.length < PAGE_SIZE || last === undefined) return out;
    cursor = String(last._id);
  }
  throw new Error(
    `alibaba-catalog-sync: ${collection} exceeded ${MAX_PAGES * PAGE_SIZE} rows in a cursor walk`,
  );
}
