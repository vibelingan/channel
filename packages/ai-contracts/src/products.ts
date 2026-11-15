export interface PublicProductCard {
  id: string;
  name: string;
  summary: string;
  revision: string;
  href: string;
  imageUrl?: string;
  retrievedAt?: string;
  /** Features the visitor asked for that this product's public facts do not show. */
  toConfirm?: string[];
}
/** One batch of a product search. A total is never claimed: only whether more exist. */
export interface ProductResultSet {
  batch: number;
  hasMore: boolean;
}
export const PRODUCT_BATCH_SIZE = 5;
export type CatalogAction =
  | { kind: 'search'; query: string }
  | { kind: 'lookup'; ids: string[] }
  /** The next batch after the answer to the question with this operation key. */
  | { kind: 'more'; after: string };
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export function isCatalogAction(v: unknown): v is CatalogAction {
  if (!record(v)) return false;
  if (v.kind === 'more')
    return (
      Object.keys(v).length === 2 &&
      typeof v.after === 'string' &&
      /^[a-zA-Z0-9_-]{8,128}$/.test(v.after)
    );
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
      (typeof v.retrievedAt === 'string' && Number.isFinite(Date.parse(v.retrievedAt)))) &&
    (v.toConfirm === undefined || isFeatureList(v.toConfirm))
  );
}
export function isFeatureList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 4 &&
    v.every((f) => typeof f === 'string' && f.trim().length > 0 && f.length <= 40)
  );
}
export function isProductResultSet(v: unknown): v is ProductResultSet {
  return (
    record(v) &&
    Object.keys(v).length === 2 &&
    typeof v.batch === 'number' &&
    Number.isSafeInteger(v.batch) &&
    v.batch >= 1 &&
    v.batch <= 20 &&
    typeof v.hasMore === 'boolean'
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
export const PRODUCT_KINDS = [
  'answer',
  'clarification',
  'no_match',
  'product_updated',
  'team_followup',
  'unsupported',
] as const;
export interface InquirySuggestion {
  requirement: string;
  productId?: string;
}
export function isInquirySuggestion(value: unknown): value is InquirySuggestion {
  return (
    record(value) &&
    Object.keys(value).every((k) => ['requirement', 'productId'].includes(k)) &&
    typeof value.requirement === 'string' &&
    value.requirement.trim().length > 0 &&
    value.requirement.length <= 4000 &&
    (value.productId === undefined ||
      (typeof value.productId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.productId)))
  );
}
/**
 * A follow-up the visitor can send with one click. It is only ever sent as
 * the visitor's own visible message: never a tool, an action or a submission.
 * "Show more options" is not one of these; it comes from the batch itself.
 */
export interface AnswerSuggestion {
  id: string;
  label: string;
  utterance: string;
  kind: 'ask' | 'refine';
  /** The requirement summary version the suggestion was written against. */
  baseCriteriaVersion: number;
}
export const MAX_SUGGESTIONS = 3;
export function isAnswerSuggestions(v: unknown): v is AnswerSuggestion[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= MAX_SUGGESTIONS &&
    v.every(
      (s) =>
        record(s) &&
        Object.keys(s).length === 5 &&
        typeof s.id === 'string' &&
        /^s[1-3]$/.test(s.id) &&
        typeof s.label === 'string' &&
        s.label.trim().length > 0 &&
        s.label.length <= 40 &&
        typeof s.utterance === 'string' &&
        s.utterance.trim().length > 0 &&
        s.utterance.length <= 160 &&
        (s.kind === 'ask' || s.kind === 'refine') &&
        Number.isSafeInteger(s.baseCriteriaVersion) &&
        (s.baseCriteriaVersion as number) >= 0,
    ) &&
    new Set(v.map((s) => (s as AnswerSuggestion).id)).size === v.length
  );
}
