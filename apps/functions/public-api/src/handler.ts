import { get, list } from '@vibelingan-channel/db';
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

async function imageIsPublic(imageId: string): Promise<boolean> {
  if (imageId === PLACEHOLDER_IMAGE_ID) return true;
  for (const collection of CATALOGS) {
    if (await publishedCatalogReferencesImage(collection, imageId)) return true;
  }
  return false;
}

export async function getCatalogImage(imageId: string): Promise<ApiResult<unknown> | BinaryResult> {
  if (!(await imageIsPublic(imageId))) {
    return err('NOT_FOUND', 'Image not found');
  }

  const doc = await get('images', imageId);
  if (!doc || typeof doc.data !== 'string') {
    return err('NOT_FOUND', 'Image not found');
  }

  return {
    ok: true,
    body: doc.data,
    isBase64Encoded: true,
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': typeof doc.mimeType === 'string' ? doc.mimeType : 'application/octet-stream',
    },
  };
}

export function parseCatalogName(pathPart: string): PublicCatalog | null {
  return isPublicCatalog(pathPart) ? pathPart : null;
}
