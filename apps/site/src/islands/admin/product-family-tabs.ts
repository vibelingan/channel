import { type ProductFamily, isProductFamily } from '@vibelingan-channel/shared';
import type { ListArgs } from './api.ts';

export type AdminProductFamily = ProductFamily | 'unclassified' | null;
export const ADMIN_PRODUCT_FAMILY_LABELS: Record<ProductFamily, string> = {
  headphones: 'Headphones',
  'ai-gadgets': 'AI Gadgets',
  toys: 'Toys',
  misc: 'Misc',
};

export function adminProductFamilyFromSearch(search: string): AdminProductFamily {
  const value = new URLSearchParams(search).get('productFamily');
  return isProductFamily(value) || value === 'unclassified' ? value : null;
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
  const {
    productFamily: _previousFamily,
    needsClassification: _previousScope,
    ...scopedArgs
  } = args;
  return {
    ...scopedArgs,
    ...(args.collection === 'products' && productFamily
      ? productFamily === 'unclassified'
        ? { needsClassification: true }
        : { productFamily }
      : {}),
  };
}
