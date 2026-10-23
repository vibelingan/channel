/** The adapter must commit all writes together, or discard them all. */
export interface ArticleStore {
  read(collection: string, id: string): Promise<unknown>;
  write(collection: string, id: string, value: Record<string, unknown>): Promise<void>;
}
export type ArticleStoreTransaction = <T>(
  operation: (store: ArticleStore) => Promise<T>,
) => Promise<T>;
