/**
 * Browser API client for the admin dashboard.
 *
 * All requests go to a single endpoint (`/api/admin`) using the same
 * `{ action, data, token }` protocol the cloud function and local-server speak.
 * The session token is shared with the rest of the site via `lib/session`.
 */
import {
  type CategoryApiRequest,
  CategoryApiResponseSchema,
  type CollectionDoc,
  type FilterModel,
  type ListResult,
  PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  type SessionUser,
  type SortClause,
  isProductFamily,
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

async function call<T>(action: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token: getToken() }),
    credentials: 'omit',
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
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

export function catalogApprovalCall(data: unknown, signal?: AbortSignal) {
  return call<unknown>('catalogDetailApproval', data, signal);
}

export function fetchCurrentUser(): Promise<{ user: SessionUser }> {
  return call<{ user: SessionUser }>('me');
}

export async function manageCategoryAssignments(input: CategoryApiRequest) {
  const response = CategoryApiResponseSchema.safeParse(
    await call<unknown>('catalogCategories', input),
  );
  if (!response.success)
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Category response was malformed. Refresh the preview before retrying.',
    );
  return response.data;
}

export interface ListArgs {
  collection: string;
  productFamily?: ProductFamily;
  needsClassification?: boolean;
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

export async function updateRecord(
  collection: string,
  id: string,
  values: Record<string, unknown>,
): Promise<CollectionDoc> {
  let refreshPublishedDetail = false;
  if (
    collection === 'products' &&
    values.published === undefined &&
    isProductFamily(values.productFamily)
  ) {
    const current = await call<CollectionDoc>('get', { collection, id });
    if (current.published === true && typeof current.alibabaPrimarySourceKey === 'string') {
      // Refresh the approved detail without inventing publication intent. Another
      // admin may withdraw the product while this operation is in flight.
      refreshPublishedDetail = true;
    }
  }
  if (collection === 'products' && (values.published === true || refreshPublishedDetail)) {
    const capabilities = await call<{ enabled: boolean }>('catalogDetailCapabilities');
    if (typeof capabilities?.enabled !== 'boolean')
      throw new AdminApiError('INVALID_RESPONSE', 'Approval capability could not be confirmed.');
    if (capabilities.enabled) {
      let current = await call<CollectionDoc>('get', { collection, id });
      if (typeof current.alibabaPrimarySourceKey === 'string') {
        // Save reviewed form edits first without changing publication. Preparation
        // and approval have resumable, server-checked requests, not one long call.
        const { published: _published, ...draftValues } = values;
        if (Object.keys(draftValues).length)
          current = await call<CollectionDoc>('update', { collection, id, values: draftValues });
        if (!isProductFamily(current.productFamily))
          throw new AdminApiError(
            'INVALID_PRODUCT',
            'Choose a website category before publishing.',
          );
        if (!Array.isArray(current.imageIds) || current.imageIds.length === 0) {
          const [{ importAlibabaGallery }, { importAlibabaSourceImage }] = await Promise.all([
            import('./alibaba-gallery-import.ts'),
            import('./alibaba-catalog-sync/alibaba-api.ts'),
          ]);
          const imported = await importAlibabaGallery({
            sourceUrls: current.alibabaSourceImageUrls,
            imageIds: [],
            importImage: importAlibabaSourceImage,
            onProgress: () => {},
          });
          if (imported.failures.length || imported.remaining)
            throw new AdminApiError(
              'MEDIA_NOT_READY',
              'Some images could not be imported. Open Edit and retry the source gallery.',
            );
          if (imported.imageIds.length)
            await call('update', { collection, id, values: { imageIds: imported.imageIds } });
        }
        if (
          // Existing publications keep their reviewed website media. A later
          // sync is not permission to import/publish additional supplier images
          // as a side effect of Save or a category-only refresh.
          !refreshPublishedDetail &&
          current.published !== true &&
          current.descriptionImageIds === undefined &&
          Array.isArray(current.alibabaDescriptionImageUrls) &&
          current.alibabaDescriptionImageUrls.length
        ) {
          if (current.alibabaDescriptionImageUrls.length > PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT)
            throw new AdminApiError(
              'MEDIA_NOT_READY',
              `Import up to ${PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT} description images in Edit and review them before publishing.`,
            );
          const [{ importAlibabaGallery }, { importAlibabaSourceImage }] = await Promise.all([
            import('./alibaba-gallery-import.ts'),
            import('./alibaba-catalog-sync/alibaba-api.ts'),
          ]);
          const imported = await importAlibabaGallery({
            sourceUrls: current.alibabaDescriptionImageUrls,
            imageIds: [],
            maxItems: PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
            importImage: importAlibabaSourceImage,
            onProgress: () => {},
          });
          if (imported.failures.length || imported.remaining)
            throw new AdminApiError(
              'MEDIA_NOT_READY',
              'Review and import description images in Edit before publishing.',
            );
          if (imported.imageIds.length)
            await call('update', {
              collection,
              id,
              values: { descriptionImageIds: imported.imageIds },
            });
        }
        const { prepareDetailReview, approveDetailReview } = await import(
          './catalog-detail-approval-api.ts'
        );
        const review = await prepareDetailReview(id);
        await approveDetailReview(review, crypto.randomUUID());
        if (refreshPublishedDetail) return call<CollectionDoc>('get', { collection, id });
        return call<CollectionDoc>('update', { collection, id, values: { published: true } });
      }
    }
  }
  return call<CollectionDoc>('update', { collection, id, values });
}

export function removeRecord(collection: string, id: string): Promise<{ deleted: boolean }> {
  return call<{ deleted: boolean }>('remove', { collection, id });
}

export interface BatchUpdateFailure {
  id: string;
  code: string;
  message: string;
  outcome: 'rejected' | 'unconfirmed' | 'not-attempted';
}

export interface BatchUpdateResult {
  updated: number;
  items: CollectionDoc[];
  failures: BatchUpdateFailure[];
}

/** Products must use the server's per-product validation, identity and media locks. */
export async function batchUpdateRecords(
  collection: string,
  ids: string[],
  values: Record<string, unknown>,
): Promise<BatchUpdateResult> {
  if (collection !== 'products') {
    const result = await call<{ updated: number; items: CollectionDoc[] }>('batchUpdate', {
      collection,
      ids,
      values,
    });
    return { ...result, failures: [] };
  }
  const uniqueIds = [...new Set(ids)];
  if (
    uniqueIds.length === 0 ||
    uniqueIds.length > 20 ||
    uniqueIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    Object.keys(values).length !== 1 ||
    (typeof values.published !== 'boolean' && !isProductFamily(values.productFamily))
  ) {
    throw new AdminApiError(
      'BAD_REQUEST',
      'Select up to 20 products to publish, disable or classify.',
    );
  }
  const items: CollectionDoc[] = [];
  const failures: BatchUpdateFailure[] = [];
  let stopped = false;
  for (const id of uniqueIds) {
    if (stopped) {
      failures.push({
        id,
        code: 'NOT_ATTEMPTED',
        message: 'Not attempted because the batch stopped. Refresh before retrying.',
        outcome: 'not-attempted',
      });
      continue;
    }
    try {
      const item = await updateRecord(collection, id, values);
      if (
        !item ||
        item._id !== id ||
        Object.entries(values).some(([key, value]) => item[key] !== value)
      ) {
        throw new AdminApiError(
          'INVALID_RESPONSE',
          'The returned product did not confirm the requested status.',
        );
      }
      items.push(item);
    } catch (error) {
      // A transport/5xx/malformed response may follow a committed write. Never
      // auto-retry or claim rollback; stop and ask the operator to refresh.
      const rejected =
        error instanceof AdminApiError &&
        [
          'BAD_REQUEST',
          'VALIDATION_ERROR',
          'NOT_FOUND',
          'CONFLICT',
          'UNAUTHORIZED',
          'FORBIDDEN',
        ].includes(error.code);
      stopped =
        !rejected ||
        (error instanceof AdminApiError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code));
      failures.push({
        id,
        code: error instanceof AdminApiError ? error.code : 'NETWORK_ERROR',
        message:
          rejected && error instanceof Error
            ? error.message
            : 'Result not confirmed. Refresh the product status before retrying.',
        outcome: rejected ? 'rejected' : 'unconfirmed',
      });
    }
  }
  return { updated: items.length, items, failures };
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
