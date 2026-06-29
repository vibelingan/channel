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
    // Storage surface (verified against @cloudbase/node-sdk@2.10.0 in MIU-00 /
    // design §24.3). Note getTempFileURL's fileList is a union array, not
    // string[] (§24.3 C1). Consumed by @vibelingan-channel/media-storage via
    // injection (createCloudBaseMediaStorage(cloud)).
    uploadFile(options: {
      cloudPath: string;
      fileContent: Buffer | Uint8Array | NodeJS.ReadableStream;
    }): Promise<{ fileID: string }>;
    getTempFileURL(options: {
      fileList: (string | { fileID: string; maxAge?: number })[];
    }): Promise<{ fileList: { fileID: string; tempFileURL: string; code?: string }[] }>;
    downloadFile(options: { fileID: string }): Promise<{ fileContent: Buffer }>;
    deleteFile(options: { fileList: string[] }): Promise<{ fileList: unknown[] }>;
  }

  const cloud: Cloud;
  export type { Cloud, Database, Command, CollectionReference, DocumentReference };
  export default cloud;
}
