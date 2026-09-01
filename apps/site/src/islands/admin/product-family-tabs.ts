import { type ProductFamily, isProductFamily } from '@vibelingan-channel/shared';
import type { ListArgs } from './api.ts';

export type AdminProductFamily = ProductFamily | null;

export function adminProductFamilyFromSearch(search: string): AdminProductFamily {
  const value = new URLSearchParams(search).get('productFamily');
  return isProductFamily(value) ? value : null;
}

export function adminProductFamilySearch(
  search: string,
  productFamily: AdminProductFamily,
): string {
  const params = new URLSearchParams(search);
  if (productFamily) params.set('productFamily', productFamily);
  else params.delete('productFamily');
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function productFamilyListArgs(args: ListArgs, productFamily: AdminProductFamily): ListArgs {
  return {
    ...args,
    ...(args.collection === 'products' && productFamily ? { productFamily } : {}),
  };
}
