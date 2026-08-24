import type { CatalogPage, PublicProduct } from '@vibelingan-channel/shared/catalog';
import { CatalogPageSchema } from '@vibelingan-channel/shared/catalog';
import { readApiEnvelope } from '../../lib/api-envelope.ts';
import { apiMediaUrl, apiUrl } from '../../lib/api-url.ts';
import { getToken } from '../../lib/session.ts';

export interface CatalogPageQuery {
  productFamily?: PublicProduct['productFamily'];
  categories?: readonly string[];
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function fetchCatalogPage(
  query: CatalogPageQuery = {},
  signal?: AbortSignal,
): Promise<CatalogPage<PublicProduct>> {
  const params = new URLSearchParams();
  if (query.productFamily) params.set('productFamily', query.productFamily);
  if (query.categories && query.categories.length > 0) {
    params.set('category', query.categories.join(','));
  }
  if (query.search) params.set('search', query.search);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const queryString = params.toString();
  const token = getToken();
  const response = await fetch(apiUrl(`/api/products${queryString ? `?${queryString}` : ''}`), {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    signal,
  });
  if (!response.ok) throw new Error(`Failed to load catalog (${response.status})`);

  const envelope = await readApiEnvelope<unknown>(response);
  if (!envelope?.ok) {
    throw new Error(envelope ? envelope.error.message : 'Invalid catalog response');
  }
  const parsed = CatalogPageSchema.safeParse(envelope.data);
  if (!parsed.success) throw new Error('Invalid catalog response');

  return {
    ...parsed.data,
    items: parsed.data.items.map((product) => ({
      ...product,
      ...(product.images ? { images: product.images.map(apiMediaUrl) } : {}),
    })),
  };
}
