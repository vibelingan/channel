export type SharedPreviewTarget =
  | { status: 'legacy' | 'invalid' }
  | { status: 'preview'; productId: string; requestedId?: string };
export function sharedPreviewTarget(development: boolean, search: string): SharedPreviewTarget {
  if (!development) return { status: 'legacy' };
  const params = new URLSearchParams(search);
  if (!params.has('preview')) return { status: 'legacy' };
  const productId = params.get('id');
  const variant = params.get('variant');
  const valid = (value: string | null) =>
    value !== null &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== '.' &&
    value !== '..' &&
    value.trim() === value &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    );
  if (
    params.get('preview') !== 'shared' ||
    params.getAll('preview').length !== 1 ||
    params.getAll('id').length !== 1 ||
    params.getAll('variant').length > 1 ||
    params.has('slug') ||
    !valid(productId) ||
    (params.has('variant') && !valid(variant)) ||
    productId === null
  )
    return { status: 'invalid' };
  return { status: 'preview', productId, ...(variant !== null ? { requestedId: variant } : {}) };
}
