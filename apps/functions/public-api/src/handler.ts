import { get, list } from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import {
  type ApiResult,
  type CollectionDoc,
  type FilterClause,
  err,
  ok,
} from '@vibelingan-channel/shared';

const CATALOGS = ['products', 'overstock'] as const;
const MAX_PUBLIC_PAGE_SIZE = 48;
const IMAGE_SCAN_PAGE_SIZE = 100;
const PLACEHOLDER_IMAGE_ID = '_placeholder';

export type PublicCatalog = (typeof CATALOGS)[number];

export interface CatalogQuery {
  categories?: readonly string[];
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface PublicApiConfig {
  apiBaseUrl?: string;
}

export interface BinaryResult {
  ok: true;
  body: string;
  isBase64Encoded: true;
  headers: Record<string, string>;
}

function isPublicCatalog(value: string): value is PublicCatalog {
  return (CATALOGS as readonly string[]).includes(value);
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function apiUrl(path: string, config: PublicApiConfig): string {
  const base = normalizeBaseUrl(config.apiBaseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

function imageUrl(id: string, config: PublicApiConfig): string {
  return apiUrl(`/api/images/${encodeURIComponent(id)}`, config);
}

function catalogImages(doc: CollectionDoc, config: PublicApiConfig): string[] {
  const ids = Array.isArray(doc.imageIds) ? doc.imageIds.map(String) : [];
  return ids.map((id) => imageUrl(id, config));
}

function publicDoc(doc: CollectionDoc, config: PublicApiConfig): CollectionDoc {
  return { ...doc, images: catalogImages(doc, config) };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

export async function listCatalog(
  collection: PublicCatalog,
  query: CatalogQuery,
  config: PublicApiConfig,
): Promise<ApiResult<unknown>> {
  const page = positiveInt(query.page, 1);
  const pageSize = Math.min(MAX_PUBLIC_PAGE_SIZE, positiveInt(query.pageSize, 24));
  const clauses: FilterClause[] = [{ field: 'published', op: 'eq', value: true }];
  const categories = query.categories?.map((c) => c.trim()).filter(Boolean) ?? [];
  if (categories.length > 0) {
    clauses.push({ field: 'category', op: 'in' as const, value: categories });
  }

  const result = await list({
    collection,
    page,
    pageSize,
    search: query.search ?? '',
    filter: { combinator: 'and', clauses },
  });

  return ok({
    items: result.items.map((doc) => publicDoc(doc, config)),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}

export async function getCatalogItem(
  collection: PublicCatalog,
  id: string,
  config: PublicApiConfig,
): Promise<ApiResult<unknown>> {
  const doc = await get(collection, id);
  if (!doc || doc.published !== true) {
    return err('NOT_FOUND', 'Item not found');
  }
  return ok(publicDoc(doc, config));
}

async function publishedCatalogReferencesImage(
  collection: PublicCatalog,
  imageId: string,
): Promise<boolean> {
  let page = 1;
  for (;;) {
    const result = await list({
      collection,
      page,
      pageSize: IMAGE_SCAN_PAGE_SIZE,
      search: '',
      filter: {
        combinator: 'and',
        clauses: [{ field: 'published', op: 'eq', value: true }],
      },
    });
    if (
      result.items.some(
        (doc) => Array.isArray(doc.imageIds) && doc.imageIds.map(String).includes(imageId),
      )
    ) {
      return true;
    }
    if (page * result.pageSize >= result.total || result.items.length === 0) return false;
    page += 1;
  }
}

/**
 * Legacy compatibility fallback: scan published catalogs for a reference to this
 * image. Used ONLY for legacy-base64 rows that predate `publishedRefCount`; once
 * the Phase-D backfill runs, the ref count is canonical for every provider and
 * this O(catalog) scan is no longer reached.
 */
async function legacyImageIsPublicFallback(imageId: string): Promise<boolean> {
  for (const collection of CATALOGS) {
    if (await publishedCatalogReferencesImage(collection, imageId)) return true;
  }
  return false;
}

function binaryImage(doc: CollectionDoc, body: string): BinaryResult {
  return {
    ok: true,
    body,
    isBase64Encoded: true,
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': typeof doc.mimeType === 'string' ? doc.mimeType : 'application/octet-stream',
    },
  };
}

export async function getCatalogImage(imageId: string): Promise<ApiResult<unknown> | BinaryResult> {
  const doc = await get('images', imageId);
  if (!doc) return err('NOT_FOUND', 'Image not found');

  // The placeholder is public by explicit id — never gated on refcount/status.
  if (imageId === PLACEHOLDER_IMAGE_ID) {
    return typeof doc.data === 'string'
      ? binaryImage(doc, doc.data)
      : err('NOT_FOUND', 'Image not found');
  }

  const provider = typeof doc.storageProvider === 'string' ? doc.storageProvider : 'legacy-base64';
  const refCount = Number(doc.publishedRefCount ?? 0);
  // A positive, finite ref count is the only "visible" signal (fail closed: a
  // corrupt/non-finite counter must NOT render — NaN comparisons are false).
  const visibleByRefCount = Number.isFinite(refCount) && refCount > 0;
  const hasRefCount = Object.hasOwn(doc, 'publishedRefCount') && Number.isFinite(refCount);

  if (provider === 'legacy-base64') {
    // Trust the ref count once it exists (post-backfill); until then fall back to
    // the O(catalog) scan so legacy rows keep rendering.
    const visible = hasRefCount ? visibleByRefCount : await legacyImageIsPublicFallback(imageId);
    if (!visible || typeof doc.data !== 'string') return err('NOT_FOUND', 'Image not found');
    return binaryImage(doc, doc.data);
  }

  // Storage-backed (cloudbase-storage / local-disk): publishedRefCount + status
  // are canonical — no catalog scan. Bytes are proxied via the media adapter.
  if (doc.status !== 'active' || !visibleByRefCount || typeof doc.storageFileId !== 'string') {
    return err('NOT_FOUND', 'Image not found');
  }
  try {
    const object = await mediaStorage().getObjectAsBase64(doc.storageFileId);
    return binaryImage(doc, object.body);
  } catch (e) {
    // Active metadata but unfetchable bytes (missing object / transient store
    // error): 404 for public delivery rather than leaking a 500.
    console.error(`[fn-public-api] storage fetch failed for image ${imageId}:`, e);
    return err('NOT_FOUND', 'Image not found');
  }
}

export function parseCatalogName(pathPart: string): PublicCatalog | null {
  return isPublicCatalog(pathPart) ? pathPart : null;
}
