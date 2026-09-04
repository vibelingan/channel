/**
 * Browser API client for the admin dashboard.
 *
 * All requests go to a single endpoint (`/api/admin`) using the same
 * `{ action, data, token }` protocol the cloud function and local-server speak.
 * The session token is shared with the rest of the site via `lib/session`.
 */
import {
  type CollectionDoc,
  type FilterModel,
  type ListResult,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  type SessionUser,
  type SortClause,
} from '@vibelingan-channel/shared';
import { readApiEnvelope } from '../../lib/api-envelope.ts';
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

  const result = await readApiEnvelope<T>(res);
  if (!result) {
    throw new AdminApiError(
      res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
      `Request failed (${res.status})`,
    );
  }
  if (!result.ok) {
    throw new AdminApiError(result.error.code, result.error.message);
  }
  return result.data;
}

export function fetchCurrentUser(): Promise<{ user: SessionUser }> {
  return call<{ user: SessionUser }>('me');
}

export interface ListArgs {
  collection: string;
  productFamily?: ProductFamily;
  page?: number;
  pageSize?: number;
  search?: string;
  filter?: FilterModel;
  sort?: SortClause[];
}

export function listRecords(args: ListArgs): Promise<ListResult<CollectionDoc>> {
  return call<ListResult<CollectionDoc>>('list', args);
}

export interface ProductReviewSummary {
  pendingTotal: number;
  byFamily: Record<ProductFamily, number>;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Fail closed on a malformed server payload so bad counts never become UI state. */
export function decodeProductReviewSummary(value: unknown): ProductReviewSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminApiError('INVALID_RESPONSE', 'Product review summary was malformed.');
  }
  const record = value as Record<string, unknown>;
  const byFamily = record.byFamily;
  if (!byFamily || typeof byFamily !== 'object' || Array.isArray(byFamily)) {
    throw new AdminApiError('INVALID_RESPONSE', 'Product review summary was malformed.');
  }
  const familyRecord = byFamily as Record<string, unknown>;
  const families: readonly ProductFamily[] = PRODUCT_FAMILY_OPTIONS;
  if (
    !isNonNegativeSafeInteger(record.pendingTotal) ||
    !families.every((family) => isNonNegativeSafeInteger(familyRecord[family]))
  ) {
    throw new AdminApiError('INVALID_RESPONSE', 'Product review summary was malformed.');
  }
  const mappedTotal = families.reduce((sum, family) => sum + Number(familyRecord[family]), 0);
  if (mappedTotal > record.pendingTotal) {
    throw new AdminApiError('INVALID_RESPONSE', 'Product review summary was inconsistent.');
  }
  return {
    pendingTotal: record.pendingTotal,
    byFamily: {
      headphones: Number(familyRecord.headphones),
      'ai-gadgets': Number(familyRecord['ai-gadgets']),
      toys: Number(familyRecord.toys),
      misc: Number(familyRecord.misc),
    },
  };
}

export async function fetchProductReviewSummary(): Promise<ProductReviewSummary> {
  return decodeProductReviewSummary(await call<unknown>('productReviewSummary'));
}

export function markProductReviewed(productId: string): Promise<CollectionDoc> {
  return call<CollectionDoc>('markProductReviewed', { productId });
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
  upload: { method: 'PUT'; url: string; headers: Record<string, string> };
}

/**
 * Upload an image via the admin-brokered direct-upload flow (MIU-Upload):
 *   1. ask the server for a single-object pre-signed credential (createUploadIntent);
 *   2. `PUT` the raw bytes straight to COS — bypassing the function byte cap;
 *   3. have the server verify + activate (completeUpload).
 * Returns the new image id. The browser never holds a storage identity — only the
 * custom JWT (carried by `call`); the COS signature is server-minted.
 *
 * PUT with credential HEADERS, never a multipart POST: the signature is minted
 * through @cloudbase/node-sdk 3.x, which asks the control plane to sign for
 * `put`. A multipart POST against that signature is rejected by COS with 403
 * SignatureDoesNotMatch.
 */
export async function uploadImage(file: File): Promise<string> {
  const intent = await call<UploadIntentResponse>('createUploadIntent', {
    fileName: file.name,
    mimeType: file.type,
    byteSize: file.size,
  });

  const put = await fetch(intent.upload.url, {
    method: intent.upload.method,
    headers: intent.upload.headers,
    body: file,
  });
  if (!put.ok) {
    // Leave the pending doc for orphan cleanup; surface a clear error.
    throw new AdminApiError('UPLOAD_FAILED', `Storage upload failed (${put.status})`);
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
