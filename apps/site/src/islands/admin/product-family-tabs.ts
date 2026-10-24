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

const SUBCATEGORY_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** A subcategory is only meaningful inside one website main category. */
export function adminSubcategoryFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const value = params.get('subcategory');
  return isProductFamily(params.get('productFamily')) && value && SUBCATEGORY_ID.test(value)
    ? value
    : null;
}

export function adminProductFamilySearch(
  search: string,
  productFamily: AdminProductFamily,
  subcategoryId: string | null = null,
): string {
  const params = new URLSearchParams(search);
  if (productFamily) params.set('productFamily', productFamily);
  else params.delete('productFamily');
  if (isProductFamily(productFamily) && subcategoryId) params.set('subcategory', subcategoryId);
  else params.delete('subcategory');
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function productFamilyListArgs(
  args: ListArgs,
  productFamily: AdminProductFamily,
  subcategoryId: string | null = null,
): ListArgs {
  const {
    productFamily: _previousFamily,
    needsClassification: _previousScope,
    subcategoryIds: _previousSubcategories,
    ...scopedArgs
  } = args;
  if (args.collection !== 'products' || !productFamily) return scopedArgs;
  if (productFamily === 'unclassified') return { ...scopedArgs, needsClassification: true };
  return {
    ...scopedArgs,
    productFamily,
    ...(subcategoryId ? { subcategoryIds: [subcategoryId] } : {}),
  };
}
