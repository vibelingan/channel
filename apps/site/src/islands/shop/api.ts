/** Shared product types + API client for the storefront islands. */
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

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
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
  const json = (await res.json()) as ApiEnvelope<CatalogPage>;
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? 'Failed to load catalog');
  return resolveCatalogMedia(
    json.data,
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
  const json = (await res.json()) as ApiEnvelope<Product>;
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? 'Failed to load item');
  return resolveProductMedia(
    json.data,
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
  const json = (await res.json()) as ApiEnvelope<Product>;
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? 'Failed to load item');
  return resolveProductMedia(json.data, PRODUCT_IMAGE_LIMIT);
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
