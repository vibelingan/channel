import {
  type CatalogClassificationAssignmentRequest,
  CatalogClassificationAssignmentRequestSchema,
  type CatalogClassificationAssignmentResult,
  CatalogClassificationAssignmentResultSchema,
  type CatalogTaxonomyCommand,
  CatalogTaxonomyCommandSchema,
  type CatalogTaxonomyResult,
  CatalogTaxonomyResultSchema,
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
/**
 * Browser API client for the admin dashboard.
 *
 * All requests go to a single endpoint (`/api/admin`) using the same
 * `{ action, data, token }` protocol the cloud function and local-server speak.
 * The session token is shared with the rest of the site via `lib/session`.
 */
import {
  type SupplierReview,
  SupplierReviewSchema,
} from '@vibelingan-channel/shared/catalog-supplier-review';
import { z } from 'zod';
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

/** The new product was saved as a draft, but publishing it failed (MIU-37). */
export class DraftSavedError extends AdminApiError {
  constructor(
    code: string,
    message: string,
    public readonly draft: CollectionDoc,
  ) {
    super(code, `Saved as a draft, not published: ${message}`);
    this.name = 'DraftSavedError';
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

const PhotoSourceSchema = z.object({ url: z.string(), imageId: z.string().nullable() });
const PhotoSourcesSchema = z.object({
  ok: z.literal(true),
  gallery: z.array(PhotoSourceSchema),
  description: z.array(PhotoSourceSchema),
});

/** Every Alibaba photo of a product with our copy when we have one; admins only. */
export async function fetchPhotoSources(productId: string): Promise<{
  gallery: z.infer<typeof PhotoSourceSchema>[];
  description: z.infer<typeof PhotoSourceSchema>[];
}> {
  const parsed = PhotoSourcesSchema.safeParse(
    await catalogApprovalCall({ action: 'photo-sources', productId }),
  );
  if (!parsed.success)
    throw new AdminApiError('INVALID_RESPONSE', 'The Alibaba photos could not be read.');
  return { gallery: parsed.data.gallery, description: parsed.data.description };
}

/** What changed at Alibaba for one product (DEC-19, DEC-20); read-only, admins only. */
export async function fetchSupplierReview(productId: string): Promise<SupplierReview> {
  const parsed = SupplierReviewSchema.safeParse(
    await catalogApprovalCall({ action: 'supplier-review', productId }),
  );
  if (!parsed.success)
    throw new AdminApiError('INVALID_RESPONSE', 'The supplier review could not be read.');
  return parsed.data;
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

const suggestionIdentifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const suggestionBase = {
  kind: z.literal('suggestion'),
  productId: suggestionIdentifier,
};
const suggestionSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...suggestionBase,
      status: z.literal('ready'),
      productUpdatedAt: z.string().datetime(),
      source: z
        .object({
          primarySourceKey: suggestionIdentifier,
          sourceCategoryId: z.string().regex(/^\d{1,200}$/),
        })
        .strict(),
      mapping: z
        .object({
          id: suggestionIdentifier,
          revision: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      family: z.enum(PRODUCT_FAMILY_OPTIONS),
      subcategoryIds: z
        .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/))
        .max(16)
        .refine((ids) => new Set(ids).size === ids.length),
      taxonomyRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      ...suggestionBase,
      status: z.enum([
        'forbidden',
        'missing',
        'no-source',
        'unmapped',
        'review-required',
        'conflict',
        'invalid',
      ]),
    })
    .strict(),
]);

export type CategorySuggestion = z.infer<typeof suggestionSchema>;

export async function fetchCategorySuggestion(
  productId: string,
  signal?: AbortSignal,
): Promise<CategorySuggestion> {
  const id = suggestionIdentifier.parse(productId);
  const response = suggestionSchema.safeParse(
    await call<unknown>('catalogCategories', { kind: 'suggestion', productId: id }, signal),
  );
  if (!response.success || response.data.productId !== id)
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Classification suggestion was malformed. Reload the suggestion.',
    );
  return response.data;
}

export function categorySuggestionMatchesProduct(
  suggestion: Extract<CategorySuggestion, { status: 'ready' }>,
  product: CollectionDoc,
): boolean {
  const review = product.alibabaSourceReview;
  const nested =
    review && typeof review === 'object' && !Array.isArray(review)
      ? (review as Record<string, unknown>).sourceCategoryId
      : undefined;
  const direct = product.alibabaSourceCategoryId;
  if (typeof direct === 'string' && typeof nested === 'string' && direct !== nested) return false;
  const category = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : '';
  return (
    product._id === suggestion.productId &&
    product.updatedAt === suggestion.productUpdatedAt &&
    product.alibabaPrimarySourceKey === suggestion.source.primarySourceKey &&
    category === suggestion.source.sourceCategoryId
  );
}

export interface ListArgs {
  collection: string;
  productFamily?: ProductFamily;
  needsClassification?: boolean;
  /** Admin-only; valid only with `productFamily`, resolved against the saved registry by the server. */
  subcategoryIds?: string[];
  page?: number;
  pageSize?: number;
  search?: string;
  filter?: FilterModel;
  sort?: SortClause[];
}

export function listRecords(args: ListArgs): Promise<ListResult<CollectionDoc>> {
  return call<ListResult<CollectionDoc>>('list', args);
}

export async function getRecord(collection: string, id: string): Promise<CollectionDoc> {
  const record = await call<CollectionDoc>('get', { collection, id });
  if (record?._id !== id)
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Product status response did not match the request.',
    );
  return record;
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

export async function createRecord(
  collection: string,
  values: Record<string, unknown>,
): Promise<CollectionDoc> {
  if (collection !== 'products' || values.published !== true)
    return call<CollectionDoc>('create', { collection, values });
  // Publishing needs a category and a photo: say so in the form, before a
  // draft exists.
  if (!isProductFamily(values.productFamily))
    throw new AdminApiError('VALIDATION_ERROR', 'Choose a website category before publishing.');
  if (!Array.isArray(values.imageIds) || values.imageIds.length === 0)
    throw new AdminApiError(
      'VALIDATION_ERROR',
      'Add at least one product image before publishing.',
    );
  // A new product has no approved version, so it starts as a draft and
  // publishing it is an approval, like any other product (MIU-37).
  const draft = await call<CollectionDoc>('create', {
    collection,
    values: { ...values, published: false },
  });
  try {
    return await updateRecord(collection, draft._id, { published: true });
  } catch (error) {
    const code = error instanceof AdminApiError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof Error ? error.message : 'Publishing failed.';
    throw new DraftSavedError(code, message, draft);
  }
}

export async function updateRecord(
  collection: string,
  id: string,
  values: Record<string, unknown>,
  expectedUpdatedAt?: string,
): Promise<CollectionDoc> {
  let refreshPublishedDetail = false;
  if (
    collection === 'products' &&
    values.published === undefined &&
    isProductFamily(values.productFamily)
  ) {
    const current = await call<CollectionDoc>('get', { collection, id });
    if (current.published === true) {
      // Refresh the approved detail without inventing publication intent. Another
      // admin may withdraw the product while this operation is in flight. Manual
      // products too: an admin edit is their source (MIU-32).
      refreshPublishedDetail = true;
    }
  }
  if (collection === 'products' && (values.published === true || refreshPublishedDetail)) {
    // Approval is for admins. A contributor's save goes straight to the server,
    // which keeps an edit on a live product as a draft for an admin (OWN-1).
    const capabilities = await call<{ enabled: boolean }>('catalogDetailCapabilities').catch(
      (error: unknown) => {
        if (error instanceof AdminApiError && error.code === 'FORBIDDEN') return null;
        throw error;
      },
    );
    if (capabilities !== null && typeof capabilities?.enabled !== 'boolean')
      throw new AdminApiError('INVALID_RESPONSE', 'Approval capability could not be confirmed.');
    if (capabilities?.enabled) {
      let current = await call<CollectionDoc>('get', { collection, id });
      if (typeof current.alibabaPrimarySourceKey !== 'string')
        return approveManualProduct(collection, id, values, current, {
          refreshPublishedDetail,
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        });
      if (typeof current.alibabaPrimarySourceKey === 'string') {
        // A guarded publish (classification "Save and publish") is an approval
        // like Publish: from the revision the classification saved, each write
        // carrying the revision the previous one returned.
        let guard = expectedUpdatedAt;
        if (guard !== undefined) {
          if (current.updatedAt !== guard)
            throw new AdminApiError(
              'CONFLICT',
              'Product changed since classification. Refresh before publishing.',
            );
          if (
            current.alibabaReviewPending === true &&
            ['changed', 'removed'].includes(String(current.alibabaReviewReason))
          )
            throw new AdminApiError(
              'CONFLICT',
              'This product has Alibaba changes to review. Open Edit to review them, then publish.',
            );
        }
        const write = async (writeValues: Record<string, unknown>) => {
          const saved = await call<CollectionDoc>('update', {
            collection,
            id,
            values: writeValues,
            ...(guard ? { expectedUpdatedAt: guard } : {}),
          });
          if (guard) {
            if (typeof saved.updatedAt !== 'string')
              throw new AdminApiError(
                'INVALID_RESPONSE',
                'The save did not return its revision. Refresh before publishing.',
              );
            guard = saved.updatedAt;
          }
          return saved;
        };
        // Save reviewed form edits first without changing publication. The server
        // then approves in one request (step-by-step fallback, same operation id).
        const { published: _published, ...draftValues } = values;
        if (Object.keys(draftValues).length) current = await write(draftValues);
        if (!isProductFamily(current.productFamily))
          throw new AdminApiError(
            'INVALID_PRODUCT',
            'Choose a website category before publishing.',
          );
        // First publication only. A re-approval never takes newer supplier
        // text or photos on its own; the admin chooses them (DEC-18). The
        // website shows up to 18 description photos: the first 18 in
        // Alibaba's order are taken, as the Edit import does.
        const descriptionSources =
          !refreshPublishedDetail &&
          current.published !== true &&
          current.descriptionImageIds === undefined &&
          Array.isArray(current.alibabaDescriptionImageUrls)
            ? current.alibabaDescriptionImageUrls
            : [];
        if (!Array.isArray(current.imageIds) || current.imageIds.length === 0) {
          if (
            !Array.isArray(current.alibabaSourceImageUrls) ||
            current.alibabaSourceImageUrls.length === 0
          )
            throw new AdminApiError(
              'MEDIA_NOT_READY',
              'This product has no photos and Alibaba sent none. Add a photo in Edit, then publish.',
            );
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
          if (imported.imageIds.length) await write({ imageIds: imported.imageIds });
        }
        if (descriptionSources.length > 0) {
          const [{ importAlibabaGallery }, { importAlibabaSourceImage }] = await Promise.all([
            import('./alibaba-gallery-import.ts'),
            import('./alibaba-catalog-sync/alibaba-api.ts'),
          ]);
          const imported = await importAlibabaGallery({
            sourceUrls: descriptionSources,
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
          if (imported.imageIds.length) await write({ descriptionImageIds: imported.imageIds });
        }
        const { approveProduct } = await import('./catalog-detail-approval-api.ts');
        await approveProduct(id);
        if (refreshPublishedDetail) return refreshedProduct(collection, id);
        return call<CollectionDoc>('update', {
          collection,
          id,
          values: { published: true },
          ...(guard ? { expectedUpdatedAt: guard } : {}),
        });
      }
    }
  }
  return call<CollectionDoc>('update', {
    collection,
    id,
    values,
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
  });
}

/**
 * A live product after its approval was refreshed. A review flag on it is
 * cleared the way a publish clears it (DEC-11); "Changed" stays while a
 * supplier change still needs a decision (DEC-19).
 */
async function refreshedProduct(collection: string, id: string): Promise<CollectionDoc> {
  const latest = await call<CollectionDoc>('get', { collection, id });
  return latest.published === true && latest.alibabaReviewPending === true
    ? call<CollectionDoc>('update', { collection, id, values: { published: true } })
    : latest;
}

/**
 * A manual product is approved like a synced one (MIU-32): save the form edits,
 * build its version from the row (no Alibaba imports), approve, then publish.
 * A revision guard from a classification flow carries through to each write.
 */
async function approveManualProduct(
  collection: string,
  id: string,
  values: Record<string, unknown>,
  initial: CollectionDoc,
  options: { refreshPublishedDetail: boolean; expectedUpdatedAt?: string },
): Promise<CollectionDoc> {
  let current = initial;
  let guard = options.expectedUpdatedAt;
  const { published: _published, ...draftValues } = values;
  // Checked on the would-be product before anything is saved, so a refusal is a
  // definite rejection that batch publish reports as "needs attention".
  const prospective = { ...initial, ...draftValues };
  if (!isProductFamily(prospective.productFamily))
    throw new AdminApiError('VALIDATION_ERROR', 'Choose a website category before publishing.');
  if (!Array.isArray(prospective.imageIds) || prospective.imageIds.length === 0)
    throw new AdminApiError(
      'VALIDATION_ERROR',
      'Add at least one product image before publishing.',
    );
  if (Object.keys(draftValues).length) {
    current = await call<CollectionDoc>('update', {
      collection,
      id,
      values: draftValues,
      ...(guard ? { expectedUpdatedAt: guard } : {}),
    });
    if (guard) guard = typeof current.updatedAt === 'string' ? current.updatedAt : undefined;
  }
  const { approveProduct } = await import('./catalog-detail-approval-api.ts');
  await approveProduct(id);
  if (options.refreshPublishedDetail) return refreshedProduct(collection, id);
  return call<CollectionDoc>('update', {
    collection,
    id,
    values: { published: true },
    ...(guard ? { expectedUpdatedAt: guard } : {}),
  });
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

/** Products updated at once in a batch: enough to hide gateway latency, few enough to stay polite. */
export const BATCH_CONCURRENCY = 4;

/** Products must use the server's per-product validation, identity and media locks. */
export async function batchUpdateRecords(
  collection: string,
  ids: string[],
  values: Record<string, unknown>,
  expectedRevisions?: ReadonlyMap<string, string>,
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
  const isArchive =
    Object.keys(values).length === 2 && values.archived === true && values.published === false;
  const isSingleFieldUpdate =
    Object.keys(values).length === 1 &&
    (typeof values.published === 'boolean' || isProductFamily(values.productFamily));
  if (
    uniqueIds.length === 0 ||
    uniqueIds.length > 20 ||
    uniqueIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    (!isSingleFieldUpdate && !isArchive)
  ) {
    throw new AdminApiError(
      'BAD_REQUEST',
      'Select up to 20 products to publish, disable, classify or archive.',
    );
  }
  // Each product is its own request chain, and most of its time is gateway
  // latency, so a few run at once. After an uncertain result or a refused
  // session no new product starts; products already running finish and report
  // their own outcome. Results keep the selection order.
  const outcomes: Array<{ item: CollectionDoc } | { failure: BatchUpdateFailure }> = [];
  let stopped = false;
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < uniqueIds.length) {
      const index = nextIndex++;
      const id = uniqueIds[index] as string;
      if (stopped) {
        outcomes[index] = {
          failure: {
            id,
            code: 'NOT_ATTEMPTED',
            message: 'Not attempted because the batch stopped. Refresh before retrying.',
            outcome: 'not-attempted',
          },
        };
        continue;
      }
      try {
        const item = await updateRecord(collection, id, values, expectedRevisions?.get(id));
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
        outcomes[index] = { item };
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
            // Refused by the admin page before publishing: the product stays a draft.
            'MEDIA_NOT_READY',
            'INVALID_PRODUCT',
          ].includes(error.code);
        if (
          !rejected ||
          (error instanceof AdminApiError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code))
        )
          stopped = true;
        outcomes[index] = {
          failure: {
            id,
            code: error instanceof AdminApiError ? error.code : 'NETWORK_ERROR',
            message:
              rejected && error instanceof Error
                ? error.message
                : 'Result not confirmed. Refresh the product status before retrying.',
            outcome: rejected ? 'rejected' : 'unconfirmed',
          },
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, uniqueIds.length) }, () => worker()),
  );
  const items = outcomes.flatMap((outcome) => ('item' in outcome ? [outcome.item] : []));
  const failures = outcomes.flatMap((outcome) => ('failure' in outcome ? [outcome.failure] : []));
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
export function getImagePreview(id: string): Promise<string> {
  // An image's bytes never change under its id, so one fetch serves the list
  // thumbnail, the edit form and the preview alike. Failures are not kept.
  const known = imagePreviews.get(id);
  if (known) return known;
  const loading = call<{ id: string; mimeType: string; dataBase64: string }>('getImagePreview', {
    id,
  }).then((res) => `data:${res.mimeType};base64,${res.dataBase64}`);
  imagePreviews.set(id, loading);
  loading.catch(() => {
    if (imagePreviews.get(id) === loading) imagePreviews.delete(id);
  });
  if (imagePreviews.size > IMAGE_PREVIEW_CACHE_LIMIT) {
    const oldest = imagePreviews.keys().next().value;
    if (oldest !== undefined) imagePreviews.delete(oldest);
  }
  return loading;
}

const IMAGE_PREVIEW_CACHE_LIMIT = 60;
const imagePreviews = new Map<string, Promise<string>>();

export async function taxonomyCall(
  input: CatalogTaxonomyCommand,
  signal?: AbortSignal,
): Promise<CatalogTaxonomyResult> {
  const command = CatalogTaxonomyCommandSchema.parse(input);
  const response = CatalogTaxonomyResultSchema.safeParse(
    await call<unknown>('catalogCategories', command, signal),
  );
  if (
    !response.success ||
    ('registry' in response.data && response.data.registry.family !== command.family) ||
    (command.operation === 'read' &&
      response.data.status !== 'replayed' &&
      'registry' in response.data) ||
    (command.operation === 'save' &&
      'registry' in response.data &&
      (response.data.status === 'replayed' ||
        response.data.registry.revision !== command.expectedRevision + 1))
  ) {
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Category response was malformed. Reload categories before retrying.',
    );
  }
  return response.data;
}

export async function assignmentCall(
  input: CatalogClassificationAssignmentRequest,
  signal?: AbortSignal,
  expectedSuggestion?: Extract<CategorySuggestion, { status: 'ready' }>,
): Promise<CatalogClassificationAssignmentResult> {
  const command = CatalogClassificationAssignmentRequestSchema.parse(input);
  const evidence =
    expectedSuggestion === undefined ? undefined : suggestionSchema.parse(expectedSuggestion);
  const response = CatalogClassificationAssignmentResultSchema.safeParse(
    await call<unknown>(
      'catalogCategories',
      evidence ? { ...command, expectedSuggestion: evidence } : command,
      signal,
    ),
  );
  if (!response.success) {
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Product results were malformed. Refresh products before retrying.',
    );
  }
  const ids = new Set(response.data.results.map((item) => item.productId));
  if (
    ids.size !== command.products.length ||
    response.data.results.length !== command.products.length ||
    command.products.some((item) => !ids.has(item.productId))
  ) {
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'Product results were incomplete. Refresh products before retrying.',
    );
  }
  return response.data;
}

export function publishConfirmedClassification(
  command: CatalogClassificationAssignmentRequest,
  result: CatalogClassificationAssignmentResult,
): Promise<BatchUpdateResult> | null {
  const ids = command.products.map((item) => item.productId);
  const confirmed = new Set(result.results.map((item) => item.productId));
  if (
    command.includeSavedRevision !== true ||
    result.refreshRequired ||
    ids.length === 0 ||
    ids.length !== new Set(ids).size ||
    ids.length !== confirmed.size ||
    result.results.length !== ids.length ||
    ids.some((id) => !confirmed.has(id))
  )
    return null;
  const revisions = new Map<string, string>();
  for (const item of result.results) {
    if (item.status !== 'saved' || typeof item.updatedAt !== 'string') return null;
    revisions.set(item.productId, item.updatedAt);
  }
  return batchUpdateRecords('products', ids, { published: true }, revisions);
}
