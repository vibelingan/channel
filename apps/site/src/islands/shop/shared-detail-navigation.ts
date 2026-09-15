import { type SharedPreviewTarget, sharedPreviewTarget } from './shared-detail-preview-target.ts';

export function sharedListTarget(
  development: boolean,
  search: string,
): SharedPreviewTarget | { status: 'list' } {
  const params = new URLSearchParams(search);
  if (
    development &&
    params.getAll('preview').length === 1 &&
    params.get('preview') === 'shared' &&
    !['id', 'variant', 'slug'].some((key) => params.has(key))
  )
    return { status: 'list' };
  return sharedPreviewTarget(development, search);
}

function encodable(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

export function sharedDetailSearch(search: string, productId: string): string | undefined {
  const target = sharedListTarget(true, search);
  if (!['list', 'preview'].includes(target.status) || !encodable(productId)) return undefined;
  const params = new URLSearchParams(sharedListSearch(search));
  params.set('id', productId);
  const next = `?${params}`;
  return sharedPreviewTarget(true, next).status === 'preview' ? next : undefined;
}

export function sharedVariantSearch(search: string, variantId?: string): string | undefined {
  if (sharedPreviewTarget(true, search).status !== 'preview') return undefined;
  const params = new URLSearchParams(search);
  params.delete('variant');
  if (variantId !== undefined) {
    if (!encodable(variantId)) return undefined;
    params.set('variant', variantId);
  }
  const next = `?${params}`;
  return sharedPreviewTarget(true, next).status === 'preview' ? next : undefined;
}

export function sharedListSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('id');
  params.delete('variant');
  return params.size ? `?${params}` : '';
}
