/** Shared product types + API client for the storefront islands. */

export interface Product {
  _id: string;
  name: string;
  category: string;
  series?: string;
  modName?: string;
  modType?: string;
  description?: string;
  productCode?: string;
  moq?: number;
  unitPrice?: number;
  wholesalePrice?: number;
  vipPrice?: number;
  /** Overstock-only fields. */
  inventory?: number;
  clearancePrice?: number;
  /** Image references into the `images` byte collection. */
  imageIds?: string[];
  /** Resolved image URLs (built by the API from `imageIds`). */
  images?: string[];
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** A page of catalog results from the storefront API. */
export interface CatalogPage {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CatalogQuery {
  categories?: string[];
  search?: string;
  page?: number;
  pageSize?: number;
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
): Promise<CatalogPage> {
  const params = new URLSearchParams();
  if (query.categories && query.categories.length > 0) {
    params.set('category', query.categories.join(','));
  }
  if (query.search) params.set('search', query.search);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const qs = params.toString();
  const res = await fetch(`${basePath}${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`Failed to load catalog (${res.status})`);
  const json = (await res.json()) as ApiEnvelope<CatalogPage>;
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? 'Failed to load catalog');
  return json.data;
}

export async function fetchCatalogItem(basePath: string, id: string): Promise<Product> {
  const res = await fetch(`${basePath}/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`Failed to load item (${res.status})`);
  const json = (await res.json()) as ApiEnvelope<Product>;
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? 'Failed to load item');
  return json.data;
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
