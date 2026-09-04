import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeAlibabaSourceReview,
  formatAlibabaSourcePricing,
  productReviewCellValue,
} from './alibaba-source-review.ts';

const review = {
  schemaVersion: 'alibaba-source-review-v1',
  provider: 'alibaba',
  externalProductId: 'AAEHBBhgAOVTpOKZBnRePx0I',
  sourceCategoryId: '201745901',
  sourceCategoryName: 'Consumer Electronics > Headphones',
  sourceUpdatedAt: '2026-07-30T03:37:54.000Z',
  sourceListingStatus: 'published',
  variantCount: 3,
  offerCount: 3,
  modelNumbers: ['SY-T11'],
  optionNames: ['color', 'connectors', 'model number'],
  minimumOrderQuantity: 2,
  primaryPricing: {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 2,
    tiers: [
      { minimumQuantity: 2, maximumQuantity: 499, unitAmountMinor: 570 },
      { minimumQuantity: 500, maximumQuantity: 999, unitAmountMinor: 500 },
      { minimumQuantity: 1000, unitAmountMinor: 380 },
    ],
  },
};

test('source review decoder accepts the bounded server projection and rejects malformed values', () => {
  assert.deepEqual(decodeAlibabaSourceReview(review), review);
  for (const value of [
    null,
    '',
    [],
    {},
    { ...review, variantCount: -1 },
    { ...review, extra: true },
  ]) {
    assert.equal(decodeAlibabaSourceReview(value), null);
  }
});

test('source pricing always renders currency, range and quantity context', () => {
  assert.equal(
    formatAlibabaSourcePricing(review.primaryPricing),
    'USD 3.80–5.70 / unit · tiered from 2',
  );
  assert.equal(formatAlibabaSourcePricing({ mode: 'negotiable' }), 'Negotiable');
  assert.equal(formatAlibabaSourcePricing({ mode: 'unavailable' }), 'Unavailable');
  assert.equal(
    formatAlibabaSourcePricing({ mode: 'fixed', currency: 'CNY', amountMinor: 1299 }),
    'CNY 12.99 / unit',
  );
  assert.equal(formatAlibabaSourcePricing({ mode: 'fixed', currency: '', amountMinor: 1299 }), '—');
});

test('product review cells use canonical values first and source evidence only as labelled fallbacks', () => {
  const doc = { skuCode: '', modName: '', alibabaSourceReview: review };
  assert.equal(productReviewCellValue(doc, 'identity'), 'AAEHBBhgAOVTpOKZBnRePx0I');
  assert.equal(productReviewCellValue(doc, 'model'), 'SY-T11');
  assert.equal(productReviewCellValue(doc, 'variants'), '3 variants · 3 offers');
  assert.equal(productReviewCellValue(doc, 'moq'), '2');
  assert.equal(productReviewCellValue(doc, 'category'), 'Consumer Electronics > Headphones');
  assert.equal(productReviewCellValue(doc, 'pricing'), 'USD 3.80–5.70 / unit · tiered from 2');
  assert.equal(
    productReviewCellValue({ ...doc, skuCode: 'HP-100', moq: 50 }, 'identity'),
    'HP-100',
  );
  assert.equal(productReviewCellValue({ ...doc, moq: 50 }, 'moq'), '50');
});
