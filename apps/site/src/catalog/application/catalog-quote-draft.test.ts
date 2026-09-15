import assert from 'node:assert/strict';
import test from 'node:test';
import { type QuoteDraftState, currentQuoteDraft, quoteContextKey } from './catalog-quote-draft.ts';
const target = {
  intent: 'variant_quote',
  productId: 'p1',
  revision: 'r1',
  variantId: 'v1',
} as const;
test('changing product revision SKU or intent invalidates review synchronously', () => {
  const state: QuoteDraftState = {
    step: 'review',
    key: quoteContextKey(target),
    fields: {
      intent: 'variant_quote',
      quantity: '500',
      deliveryDate: '',
      customizationTypes: [],
      brief: '',
      contactName: 'Test Buyer',
      email: 'buyer@example.test',
      company: 'Test Co',
      country: 'Hong Kong',
    },
  };
  assert.equal(currentQuoteDraft(state, target).step, 'review');
  for (const change of [
    { productId: 'p2' },
    { revision: 'r2' },
    { variantId: 'v2' },
    { intent: 'customization' as const },
  ]) {
    assert.equal(currentQuoteDraft(state, { ...target, ...change }).step, 'requirements');
  }
});
