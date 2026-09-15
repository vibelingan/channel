import assert from 'node:assert/strict';
import test from 'node:test';
import { planCatalogQuote } from './catalog-quote.ts';

const input = {
  idempotencyKey: '12345678-1234-4123-8123-123456789abc',
  target: { intent: 'variant_quote', productId: 'p1', revision: 'r1', variantId: 'v1' },
  fields: {
    intent: 'variant_quote',
    quantity: '1',
    deliveryDate: '',
    customizationTypes: [],
    brief: '',
    contactName: 'Test',
    company: 'Test',
    email: 'test@example.test',
    country: 'HK',
  },
};
const product = {
  _id: 'p1',
  published: true,
  archived: false,
  catalogDetailPublication: {
    state: 'approved',
    revision: 'r1',
    variantCount: 1,
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p1',
      name: 'Authoritative title',
      images: [],
      facts: [],
      offers: [],
    },
  },
};
const variant = {
  _id: 'v1',
  productId: 'p1',
  archived: false,
  catalogDetailRevision: 'r1',
  catalogDetailApproved: {
    id: 'v1',
    options: [],
    images: [],
    inventory: { state: 'unknown' },
    offers: [],
  },
};
test('inquiry keeps the approved manual website price, never buyer input or later source changes', () => {
  const websitePricing = {
    basis: 'website-manual',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: 310 },
  };
  const p = structuredClone(product);
  const priced = {
    ...p,
    unitPrice: 99,
    catalogDetailPublication: {
      ...p.catalogDetailPublication,
      header: { ...p.catalogDetailPublication.header, websitePricing },
    },
  };
  const result = planCatalogQuote(input, priced, variant, {
    notification: 'disabled',
    now: '2026-09-07T00:00:00.000Z',
  });
  assert.ok(result.ok);
  assert.deepEqual(result.record.snapshot.websitePricing, websitePricing);
  websitePricing.pricing.amountMinor = 999;
  assert.equal(result.record.snapshot.websitePricing?.pricing.mode, 'fixed');
  assert.deepEqual(result.record.snapshot.websitePricing?.pricing, {
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 310,
  });
});
test('server quote snapshot needs published matching revision and selected SKU; cannot accept buyer snapshot', () => {
  const accepted = planCatalogQuote(input, product, variant, {
    notification: 'disabled',
    now: '2026-09-07T00:00:00.000Z',
  });
  assert.ok(accepted.ok);
  assert.equal(accepted.record.status, 'new');
  assert.equal(accepted.record.notification, 'disabled');
  assert.equal(accepted.record.snapshot.productName, 'Authoritative title');
  for (const [body, p, v] of [
    [{ ...input, snapshot: { price: 1 } }, product, variant],
    [input, { ...product, published: false }, variant],
    [input, product, { ...variant, productId: 'other' }],
    [input, product, { ...variant, catalogDetailRevision: 'old' }],
    [input, product, null],
    [input, { ...product, archived: null }, variant],
  ] as const)
    assert.equal(
      planCatalogQuote(body, p, v, { notification: 'disabled', now: '2026-09-07T00:00:00.000Z' })
        .ok,
      false,
    );
});
