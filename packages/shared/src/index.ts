export * from './api.ts';
export * from './errors.ts';
export * from './env.ts';
export * from './collections.ts';
export * from './auth.ts';

/** Shared types for the generic admin CRUD protocol. */
export interface ListQuery {
  collection: string;
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
