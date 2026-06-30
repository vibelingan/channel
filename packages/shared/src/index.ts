export * from './api.ts';
export * from './errors.ts';
export * from './env.ts';
export * from './collections.ts';
export * from './media.ts';
export * from './media-lifecycle.ts';
export * from './auth.ts';
export * from './query.ts';

import type { FilterModel, SortClause } from './query.ts';

/** Shared types for the generic admin CRUD protocol. */
export interface ListQuery {
  collection: string;
  page?: number;
  pageSize?: number;
  search?: string;
  filter?: FilterModel;
  sort?: SortClause[];
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
