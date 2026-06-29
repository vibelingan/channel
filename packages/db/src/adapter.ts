/**
 * Storage adapter abstraction.
 *
 * The repository in `index.ts` never talks to a database directly — it talks to
 * a `DbAdapter`. Production wires the CloudBase (wx-server-sdk) adapter; local
 * development wires a file-backed adapter. This keeps the persistence layer
 * swappable without any module-aliasing tricks.
 */
import type {
  CollectionDoc,
  FilterModel,
  ListQuery,
  ListResult,
  SortClause,
} from '@vibelingan-channel/shared';

/** Normalized query passed to adapters: defaults already applied. */
export interface AdapterListQuery {
  collection: string;
  page: number;
  pageSize: number;
  search: string;
  filter?: FilterModel;
  sort?: SortClause[];
}

export interface DbAdapter {
  list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>>;
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  /** Find the first document where `field` exactly equals `value`. */
  findByField(collection: string, field: string, value: unknown): Promise<CollectionDoc | null>;
  create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc>;
  update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null>;
  remove(collection: string, id: string): Promise<boolean>;
  /**
   * Atomically add `delta` to one numeric field of a document and return the
   * new value, or `null` if the document does not exist. A trusted server-side
   * primitive for maintaining server-managed counters (e.g.
   * `images.publishedRefCount`) that are read-only on the generic write surface.
   */
  incrementField(
    collection: string,
    id: string,
    field: string,
    delta: number,
  ): Promise<number | null>;
}

// Re-exported so callers building queries can reference the input shape.
export type { ListQuery };
