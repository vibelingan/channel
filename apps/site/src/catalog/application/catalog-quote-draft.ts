import type {
  CatalogQuoteFields,
  CatalogQuoteTarget,
} from '@vibelingan-channel/shared/catalog-quote';
export type QuoteDraftState =
  | { step: 'requirements' | 'contact'; key: string }
  | { step: 'review'; key: string; fields: CatalogQuoteFields };
export const quoteContextKey = (target: CatalogQuoteTarget) =>
  JSON.stringify([target.productId, target.revision, target.variantId ?? null, target.intent]);
export const currentQuoteDraft = (
  state: QuoteDraftState,
  target: CatalogQuoteTarget,
): QuoteDraftState => {
  const key = quoteContextKey(target);
  return state.key === key ? state : { step: 'requirements', key };
};
