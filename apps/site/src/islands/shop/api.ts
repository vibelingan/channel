/** Shared product types + API client for the storefront islands. */
import { isProductFamily } from '@vibelingan-channel/shared';
import { readApiEnvelope } from '../../lib/api-envelope.ts';
import { apiMediaUrl, apiUrl } from '../../lib/api-url.ts';
import { getToken } from '../../lib/session.ts';
import type { CatalogPage, CatalogQuery, Product, ProductFamily } from './catalog-types.ts';

export type { CatalogPage, CatalogQuery, Product, ProductFamily } from './catalog-types.ts';

const PRODUCT_IMAGE_LIMIT = 9;

/**
 * Attach the session token so the catalog API can verify the caller's role and
 * return role-gated pricing (VIP tier). Anonymous callers send no header and
 * receive the public projection. The server is the sole authority — the token
 * is verified there; the client never asserts entitlement.
 */
function catalogHeaders(): HeadersInit | undefined {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function optionalNumber(record: Record<string, unknown>, key: string): boolean {
  return (
    record[key] === undefined || (typeof record[key] === 'number' && Number.isFinite(record[key]))
  );
}

function isAlibabaCatalogPricing(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.schemaVersion !== 'string' ||
    value.source !== 'alibaba' ||
    typeof value.mode !== 'string' ||
    !['fixed', 'range', 'tiered', 'negotiable', 'unavailable'].includes(value.mode) ||
    typeof value.syncedAt !== 'string'
  ) {
    return false;
  }
  if (value.currency !== undefined && value.currency !== 'CNY' && value.currency !== 'USD') {
    return false;
  }
  for (const key of ['amountMinor', 'minAmountMinor', 'maxAmountMinor', 'sourceMoq']) {
    if (!optionalNumber(value, key)) return false;
  }
  for (const key of ['sourceUpdatedAt']) {
    if (!optionalString(value, key)) return false;
  }
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) return false;
    for (const tier of value.tiers) {
      if (
        !isRecord(tier) ||
        typeof tier.minQuantity !== 'number' ||
        !Number.isFinite(tier.minQuantity) ||
        typeof tier.unitAmountMinor !== 'number' ||
        !Number.isFinite(tier.unitAmountMinor) ||
        (tier.maxQuantity !== undefined &&
          (typeof tier.maxQuantity !== 'number' || !Number.isFinite(tier.maxQuantity)))
      ) {
        return false;
      }
    }
  }
  return true;
}

function isProduct(value: unknown): value is Product {
  if (!isRecord(value) || typeof value._id !== 'string' || typeof value.name !== 'string') {
    return false;
  }
  if (value.productFamily !== undefined && !isProductFamily(value.productFamily)) return false;
  for (const key of [
    'category',
    'skuCode',
    'slug',
    'series',
    'modName',
    'modType',
    'description',
    'productCode',
    'alibabaPrimarySourceKey',
    'alibabaSourceLastSyncedAt',
  ]) {
    if (!optionalString(value, key)) return false;
  }
  for (const key of [
    'moq',
    'unitPrice',
    'wholesalePrice',
    'vipPrice',
    'inventory',
    'clearancePrice',
  ]) {
    if (!optionalNumber(value, key)) return false;
  }
  if (value.images !== undefined) {
    if (!Array.isArray(value.images) || !value.images.every((image) => typeof image === 'string')) {
      return false;
    }
  }
  if (value.imageIds !== undefined) {
    if (!Array.isArray(value.imageIds) || !value.imageIds.every((id) => typeof id === 'string')) {
      return false;
    }
  }
  if (
    value.alibabaSourceStatus !== undefined &&
    (typeof value.alibabaSourceStatus !== 'string' ||
      !['available', 'limited', 'unavailable', 'removed', 'unknown'].includes(
        value.alibabaSourceStatus,
      ))
  ) {
    return false;
  }
  return (
    value.alibabaCatalogPricing === undefined ||
    isAlibabaCatalogPricing(value.alibabaCatalogPricing)
  );
}

function isCatalogPage(value: unknown): value is CatalogPage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isProduct) &&
    Number.isInteger(value.total) &&
    Number.isInteger(value.page) &&
    Number.isInteger(value.pageSize)
  );
}

function resolveProductMedia(product: Product, maxImages?: number): Product {
  if (!product.images) return product;
  const images = maxImages === undefined ? product.images : product.images.slice(0, maxImages);
  return { ...product, images: images.map(apiMediaUrl) };
}

function resolveCatalogMedia(page: CatalogPage, maxImages?: number): CatalogPage {
  return { ...page, items: page.items.map((product) => resolveProductMedia(product, maxImages)) };
}

/**
 * Fetch a page of a catalog collection from a serverless endpoint.
 * `basePath` lets the same client serve multiple catalogs (e.g. `/api/products`
 * or `/api/overstock`). Filtering, search and pagination all happen server-side
 * so large catalogs stay fast.
 */
export async function fetchCatalog(
  basePath: string,
  query: CatalogQuery = {},
  signal?: AbortSignal,
): Promise<CatalogPage> {
  const params = new URLSearchParams();
  if (query.productFamily) params.set('productFamily', query.productFamily);
  if (query.categories && query.categories.length > 0) {
    params.set('category', query.categories.join(','));
  }
  if (query.search) params.set('search', query.search);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const qs = params.toString();
  const res = await fetch(apiUrl(`${basePath}${qs ? `?${qs}` : ''}`), {
    headers: catalogHeaders(),
    signal,
  });
  if (!res.ok) throw new Error(`Failed to load catalog (${res.status})`);
  const result = await readApiEnvelope<unknown>(res);
  if (!result?.ok || !isCatalogPage(result.data)) {
    throw new Error(result && !result.ok ? result.error.message : 'Failed to load catalog');
  }
  return resolveCatalogMedia(
    result.data,
    basePath === '/api/products' ? PRODUCT_IMAGE_LIMIT : undefined,
  );
}

export async function fetchCatalogItem(
  basePath: string,
  id: string,
  signal?: AbortSignal,
): Promise<Product> {
  const res = await fetch(apiUrl(`${basePath}/${encodeURIComponent(id)}`), {
    headers: catalogHeaders(),
    signal,
  });
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`Failed to load item (${res.status})`);
  const result = await readApiEnvelope<unknown>(res);
  if (!result?.ok || !isProduct(result.data)) {
    throw new Error(result && !result.ok ? result.error.message : 'Failed to load item');
  }
  return resolveProductMedia(
    result.data,
    basePath === '/api/products' ? PRODUCT_IMAGE_LIMIT : undefined,
  );
}

export function fetchProductFamily(
  productFamily: ProductFamily,
  query: Omit<CatalogQuery, 'productFamily'> = {},
  signal?: AbortSignal,
): Promise<CatalogPage> {
  return fetchCatalog('/api/products', { ...query, productFamily }, signal);
}

export async function fetchProductBySlug(slug: string, signal?: AbortSignal): Promise<Product> {
  const res = await fetch(apiUrl(`/api/products/slug/${encodeURIComponent(slug)}`), {
    headers: catalogHeaders(),
    signal,
  });
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`Failed to load item (${res.status})`);
  const result = await readApiEnvelope<unknown>(res);
  if (!result?.ok || !isProduct(result.data)) {
    throw new Error(result && !result.ok ? result.error.message : 'Failed to load item');
  }
  return resolveProductMedia(result.data, PRODUCT_IMAGE_LIMIT);
}

export async function fetchRelatedProducts(
  product: Product,
  limit = 4,
  signal?: AbortSignal,
): Promise<Product[]> {
  if (!product.productFamily || !Number.isFinite(limit) || limit <= 0) return [];
  const boundedLimit = Math.min(47, Math.max(1, Math.trunc(limit)));
  const page = await fetchProductFamily(
    product.productFamily,
    { page: 1, pageSize: boundedLimit + 1 },
    signal,
  );
  return page.items.filter((candidate) => candidate._id !== product._id).slice(0, boundedLimit);
}

// Back-compat helpers for the headphones pages (products catalog).
export function fetchProducts(categories?: string[]): Promise<CatalogPage> {
  return fetchCatalog('/api/products', categories ? { categories } : {});
}

export function fetchProduct(id: string): Promise<Product> {
  return fetchCatalogItem('/api/products', id);
}

export type StockStatus = 'available' | 'low' | 'sold-out';

/** Derive a coarse stock status from an inventory count. */
export function stockStatus(inventory: number | undefined, lowThreshold = 100): StockStatus {
  if (inventory === undefined) return 'available';
  if (inventory <= 0) return 'sold-out';
  if (inventory < lowThreshold) return 'low';
  return 'available';
}

/** Format a number as a USD price (e.g. 12.5 -> "$12.50"). */
export function formatPrice(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}
