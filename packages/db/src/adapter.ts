/**
 * Storage adapter abstraction.
 *
 * The repository in `index.ts` never talks to a database directly — it talks to
 * a `DbAdapter`. Production wires the CloudBase (wx-server-sdk) adapter; local
 * development wires a file-backed adapter. This keeps the persistence layer
 * swappable without any module-aliasing tricks.
 */
import type { CollectionDoc, ListQuery, ListResult } from '@vibelingan-channel/shared';

export interface DbAdapter {
  list(
    query: Required<Omit<ListQuery, 'search'>> & { search: string },
  ): Promise<ListResult<CollectionDoc>>;
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc>;
  update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null>;
  remove(collection: string, id: string): Promise<boolean>;
}
