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
import { apiUrl } from '../../lib/api-url.ts';
import { getToken } from '../../lib/session.ts';

const ENDPOINT = apiUrl('/api/admin');

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
  return apiUrl(`/api/images/${encodeURIComponent(id)}`);
}

/** A short-lived, admin-authenticated OEM file download (MIU-08 §20.10 step 3). */
export interface OemFileDownload {
  fileId: string;
  url: string;
  expiresAt?: string;
  fileName: string;
  mimeType: string;
  contentDisposition: string;
}

/**
 * Mint a short-TTL temp URL for an admin to download a finalized OEM drawing.
 * Production has no public `/api/files/:id` route — OEM delivery is this
 * authenticated action. Never persist the returned URL (it expires in ~60s);
 * only `active`, storage-backed OEM rows resolve (others fail closed).
 */
export function getOemFileDownloadUrl(fileId: string): Promise<OemFileDownload> {
  return call<OemFileDownload>('getOemFileDownloadUrl', { fileId });
}

interface UploadIntentResponse {
  imageId: string;
  uploadIntentId: string;
  storageFileId: string;
  upload: { method: 'POST'; url: string; fields: Record<string, string> };
}

/**
 * Upload an image via the admin-brokered direct-upload flow (MIU-Upload):
 *   1. ask the server for a single-object pre-signed credential (createUploadIntent);
 *   2. `POST` the bytes straight to COS as multipart/form-data — bypassing the function byte cap;
 *   3. have the server verify + activate (completeUpload).
 * Returns the new image id. The browser never holds a storage identity — only the
 * custom JWT (carried by `call`); the COS signature is server-minted.
 */
export async function uploadImage(file: File): Promise<string> {
  const intent = await call<UploadIntentResponse>('createUploadIntent', {
    fileName: file.name,
    mimeType: file.type,
    byteSize: file.size,
  });

  const form = new FormData();
  for (const [key, value] of Object.entries(intent.upload.fields)) form.append(key, value);
  form.append('file', file);

  const post = await fetch(intent.upload.url, {
    method: intent.upload.method,
    body: form,
  });
  if (!post.ok) {
    // Leave the pending doc for orphan cleanup; surface a clear error.
    throw new AdminApiError('UPLOAD_FAILED', `Storage upload failed (${post.status})`);
  }

  await call('completeUpload', { imageId: intent.imageId });
  return intent.imageId;
}

/**
 * Admin-authenticated preview: fetch an image's bytes as a `data:` URL — works for
 * any image the admin may read, regardless of publication. Used by `ImageManager`
 * instead of the public `/api/images/:id` (which is `publishedRefCount`-gated and
 * 404s unpublished images). Serves legacy `data` rows and `active` storage rows.
 */
export async function getImagePreview(id: string): Promise<string> {
  const res = await call<{ id: string; mimeType: string; dataBase64: string }>('getImagePreview', {
    id,
  });
  return `data:${res.mimeType};base64,${res.dataBase64}`;
}
