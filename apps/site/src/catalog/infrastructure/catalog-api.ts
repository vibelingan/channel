import type { CatalogPage, PublicProduct } from '@vibelingan-channel/shared/catalog';

export interface CatalogPageQuery {
  productFamily?: PublicProduct['productFamily'];
  categories?: readonly string[];
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function fetchCatalogPage(
  _query: CatalogPageQuery = {},
  _signal?: AbortSignal,
): Promise<CatalogPage<PublicProduct>> {
  throw new Error('MIU 05 catalog gateway not implemented');
}
