/**
 * Browser API client for the admin dashboard.
 *
 * All requests go to a single endpoint (`/api/admin`) using the same
 * `{ action, data, token }` protocol the cloud function and local-server speak.
 * The session token is shared with the rest of the site via `lib/session`.
 */
import type {
  ApiResult,
  CollectionDoc,
  FilterModel,
  ListResult,
  SortClause,
} from '@vibelingan-channel/shared';
import { getToken } from '../../lib/session.ts';

const ENDPOINT = '/api/admin';

export class AdminApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }

  get isUnauthorized(): boolean {
    return this.code === 'UNAUTHORIZED';
  }
}

async function call<T>(action: string, data?: unknown): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token: getToken() }),
  });

  if (!res.ok) {
    throw new AdminApiError('INTERNAL_ERROR', `Request failed (${res.status})`);
  }

  const result = (await res.json()) as ApiResult<T>;
  if (!result.ok) {
    throw new AdminApiError(result.error.code, result.error.message);
  }
  return result.data;
}

export interface ListArgs {
  collection: string;
  page?: number;
  pageSize?: number;
  search?: string;
  filter?: FilterModel;
  sort?: SortClause[];
}

export function listRecords(args: ListArgs): Promise<ListResult<CollectionDoc>> {
  return call<ListResult<CollectionDoc>>('list', args);
}

export function createRecord(
  collection: string,
  values: Record<string, unknown>,
): Promise<CollectionDoc> {
  return call<CollectionDoc>('create', { collection, values });
}

export function updateRecord(
  collection: string,
  id: string,
  values: Record<string, unknown>,
): Promise<CollectionDoc> {
  return call<CollectionDoc>('update', { collection, id, values });
}

export function removeRecord(collection: string, id: string): Promise<{ deleted: boolean }> {
  return call<{ deleted: boolean }>('remove', { collection, id });
}

/** Apply the same values to many documents at once. */
export function batchUpdateRecords(
  collection: string,
  ids: string[],
  values: Record<string, unknown>,
): Promise<{ updated: number; items: CollectionDoc[] }> {
  return call<{ updated: number; items: CollectionDoc[] }>('batchUpdate', {
    collection,
    ids,
    values,
  });
}

/** Delete many documents at once; returns how many were removed. */
export function batchRemoveRecords(
  collection: string,
  ids: string[],
): Promise<{ removed: number }> {
  return call<{ removed: number }>('batchRemove', { collection, ids });
}

/** Public URL that streams the bytes of an image stored in the `images` collection. */
export function imageUrl(id: string): string {
  return `/api/images/${encodeURIComponent(id)}`;
}

/** Read a File as a base64 string (without the data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Upload an image file into the `images` byte collection; returns its id. */
export async function uploadImage(file: File): Promise<string> {
  const data = await fileToBase64(file);
  const doc = await createRecord('images', {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    data,
  });
  return doc._id;
}
