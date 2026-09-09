import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogQuoteFieldsSchema,
  quoteFieldsForDate,
  validateQuoteTarget,
} from './quote-draft.ts';

const valid = {
  intent: 'variant_quote',
  quantity: '500',
  deliveryDate: '',
  customizationTypes: [],
  brief: '',
  contactName: ' Test Buyer ',
  email: 'buyer@example.test',
  company: 'Test Co',
  country: 'HK',
};
test('quote fields normalize contact text and reject invalid quantities or forged price fields', () => {
  const parsed = CatalogQuoteFieldsSchema.safeParse(valid);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(Reflect.get(parsed.data, 'contactName'), 'Test Buyer');
  for (const quantity of ['', '0', '1.1', '1e3', ' 2', '9007199254740992', null, 2])
    assert.equal(CatalogQuoteFieldsSchema.safeParse({ ...valid, quantity }).success, false);
  for (const extra of [
    { price: 1 },
    { productName: 'Forged' },
    { contactName: ' ' },
    { email: 'bad' },
  ])
    assert.equal(CatalogQuoteFieldsSchema.safeParse({ ...valid, ...extra }).success, false);
});
test('customization requires both a known unique type and a meaningful brief; quotes cannot hide custom fields', () => {
  const custom = {
    ...valid,
    intent: 'customization',
    customizationTypes: ['logo'],
    brief: 'Use our company logo',
  };
  assert.equal(CatalogQuoteFieldsSchema.safeParse(custom).success, true);
  for (const extra of [
    { customizationTypes: [] },
    { customizationTypes: ['unknown'] },
    { customizationTypes: ['logo', 'logo'] },
    { brief: ' ' },
  ])
    assert.equal(CatalogQuoteFieldsSchema.safeParse({ ...custom, ...extra }).success, false);
  assert.equal(
    CatalogQuoteFieldsSchema.safeParse({ ...valid, customizationTypes: ['logo'] }).success,
    false,
  );
});
test('requested delivery date is a real calendar date and not in the past', () => {
  const schema = quoteFieldsForDate('2026-09-06');
  for (const deliveryDate of ['', '2026-09-06', '2027-02-28'])
    assert.equal(schema.safeParse({ ...valid, deliveryDate }).success, true);
  for (const deliveryDate of ['2026-09-05', '2027-02-29', '2026-13-01', 'September 7'])
    assert.equal(schema.safeParse({ ...valid, deliveryDate }).success, false);
});
const target = { intent: 'variant_quote', productId: 'p1', revision: 'r1', variantId: 'v1' };
test('contact country accepts only dataset country codes, not arbitrary names or lookalikes', () => {
  for (const country of ['HK', 'DE', 'US', 'CN'])
    assert.equal(CatalogQuoteFieldsSchema.safeParse({ ...valid, country }).success, true);
  for (const country of ['', 'ZZ', 'UK', 'hk', 'Hong Kong', null, {}, ' HK '])
    assert.equal(
      CatalogQuoteFieldsSchema.safeParse({ ...valid, country }).success,
      false,
      String(country),
    );
});
const current = {
  available: true,
  productId: 'p1',
  revision: 'r1',
  variant: { id: 'v1', productId: 'p1' },
};
test('target policy rejects unpublished stale or foreign SKU references independently of field validation', () => {
  assert.equal(validateQuoteTarget(target, current), undefined);
  assert.equal(validateQuoteTarget(target, { ...current, available: false }), 'unavailable');
  assert.equal(validateQuoteTarget(target, { ...current, revision: 'r2' }), 'stale-context');
  assert.equal(
    validateQuoteTarget(target, { ...current, variant: { id: 'v1', productId: 'p2' } }),
    'invalid-variant',
  );
  assert.equal(
    validateQuoteTarget({ ...target, variantId: 'missing' }, current),
    'invalid-variant',
  );
  assert.equal(
    validateQuoteTarget({ ...target, variantId: undefined }, current),
    'variant-required',
  );
  assert.equal(
    validateQuoteTarget(
      { ...target, intent: 'customization', variantId: undefined },
      { available: true, productId: 'p1', revision: 'r1' },
    ),
    undefined,
  );
  assert.equal(validateQuoteTarget({ ...target, unitPrice: 1 }, current), 'invalid-target');
});
