export interface PublicProductCard {
  id: string;
  name: string;
  summary: string;
  revision: string;
  href: string;
  imageUrl?: string;
  retrievedAt?: string;
}
export type CatalogAction = { kind: 'search'; query: string } | { kind: 'lookup'; ids: string[] };
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export function isCatalogAction(v: unknown): v is CatalogAction {
  if (!record(v)) return false;
  return v.kind === 'search'
    ? Object.keys(v).length === 2 &&
        typeof v.query === 'string' &&
        v.query.trim().length > 0 &&
        v.query.length <= 200
    : v.kind === 'lookup' &&
        Object.keys(v).length === 2 &&
        Array.isArray(v.ids) &&
        v.ids.length > 0 &&
        v.ids.length <= 2 &&
        new Set(v.ids).size === v.ids.length &&
        v.ids.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id));
}
export function isPublicProductCard(v: unknown): v is PublicProductCard {
  if (!record(v)) return false;
  return (
    typeof v.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(v.id) &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    v.name.length <= 200 &&
    typeof v.summary === 'string' &&
    v.summary.length <= 1200 &&
    typeof v.revision === 'string' &&
    v.revision.length > 0 &&
    v.revision.length <= 128 &&
    v.href === `/products/item/?id=${encodeURIComponent(v.id)}` &&
    (v.imageUrl === undefined ||
      (typeof v.imageUrl === 'string' && /^\/api\/images\/[a-zA-Z0-9_%.-]+$/.test(v.imageUrl))) &&
    (v.retrievedAt === undefined ||
      (typeof v.retrievedAt === 'string' && Number.isFinite(Date.parse(v.retrievedAt))))
  );
}
export function isProductCards(v: unknown): v is PublicProductCard[] {
  return (
    Array.isArray(v) &&
    v.length <= 6 &&
    v.every(isPublicProductCard) &&
    new Set(v.map((p) => p.id)).size === v.length
  );
}
export const PRODUCT_KINDS = ['answer', 'clarification', 'no_match', 'product_updated'] as const;
