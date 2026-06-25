/**
 * Minimal ambient type declarations for `wx-server-sdk`, covering only the
 * surface used by `@vibelingan-channel/db`. The official package ships no types.
 */
declare module 'wx-server-sdk' {
  interface QueryGetResult<T = Record<string, unknown>> {
    data: T[];
  }

  interface DocumentGetResult<T = Record<string, unknown>> {
    data: T | T[];
  }

  interface CountResult {
    total: number;
  }

  interface AddResult {
    _id: string;
  }

  interface UpdateResult {
    updated: number;
  }

  interface RemoveResult {
    deleted: number;
  }

  interface DocumentReference {
    get(): Promise<DocumentGetResult>;
    update(options: { data: Record<string, unknown> }): Promise<UpdateResult>;
    remove(): Promise<RemoveResult>;
  }

  interface Query {
    where(condition: Record<string, unknown>): Query;
    orderBy(field: string, order: 'asc' | 'desc'): Query;
    skip(offset: number): Query;
    limit(count: number): Query;
    get(): Promise<QueryGetResult>;
    count(): Promise<CountResult>;
  }

  interface CollectionReference extends Query {
    doc(id: string): DocumentReference;
    add(options: { data: Record<string, unknown> }): Promise<AddResult>;
  }

  interface Command {
    or(conditions: Record<string, unknown>[]): Record<string, unknown>;
    and(conditions: Record<string, unknown>[]): Record<string, unknown>;
    eq(value: unknown): unknown;
    neq(value: unknown): unknown;
    gt(value: unknown): unknown;
    gte(value: unknown): unknown;
    lt(value: unknown): unknown;
    lte(value: unknown): unknown;
    in(values: unknown[]): unknown;
    nin(values: unknown[]): unknown;
    exists(value: boolean): unknown;
  }

  interface Database {
    collection(name: string): CollectionReference;
    command: Command;
    RegExp(options: { regexp: string; options?: string }): unknown;
  }

  interface Cloud {
    init(options: { env: string }): void;
    database(): Database;
  }

  const cloud: Cloud;
  export type { Database, Command, CollectionReference, DocumentReference };
  export default cloud;
}
