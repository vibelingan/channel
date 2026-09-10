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
  assert.equal(productReviewCellValue(doc, 'moq'), '—');
  assert.equal(productReviewCellValue(doc, 'category'), 'Consumer Electronics > Headphones');
  assert.equal(productReviewCellValue(doc, 'pricing'), 'Request a quote');
  assert.equal(
    productReviewCellValue({ ...doc, skuCode: 'HP-100', moq: 50 }, 'identity'),
    'HP-100',
  );
  assert.equal(productReviewCellValue({ ...doc, moq: 50, unitPrice: 3.1 }, 'moq'), '50');
  assert.equal(
    productReviewCellValue({ ...doc, unitPrice: 3.1, wholesalePrice: 2.9 }, 'pricing'),
    '$2.90',
  );
});

test('untouched linked drafts show available source quotes instead of claiming pricing is missing', () => {
  const doc = { alibabaPrimarySourceKey: 'linked', alibabaSourceReview: review };
  assert.equal(
    productReviewCellValue(doc, 'pricing'),
    'Source: USD 3.80–5.70 / unit · tiered from 2',
  );
  assert.equal(productReviewCellValue(doc, 'moq'), '2 (source)');
  assert.equal(productReviewCellValue({ ...doc, unitPrice: 9 }, 'pricing'), '$9.00');
  for (const status of ['missing', 'MISSING'])
    assert.doesNotMatch(
      productReviewCellValue({ ...doc, alibabaSourceStatus: status }, 'pricing'),
      /Source:/,
    );
  for (const status of ['missing', 'draft'])
    assert.doesNotMatch(
      productReviewCellValue(
        { ...doc, alibabaSourceReview: { ...review, sourceListingStatus: status } },
        'pricing',
      ),
      /Source:/,
    );
  assert.doesNotMatch(
    productReviewCellValue({ ...doc, catalogPricingMode: 'manual' }, 'pricing'),
    /Source:/,
  );
  assert.doesNotMatch(
    productReviewCellValue(
      { ...doc, alibabaSourceReview: { ...review, primaryPricing: { mode: 'unavailable' } } },
      'pricing',
    ),
    /Source:/,
  );
});

test('known source MOQ survives unavailable pricing without inventing a source price', () => {
  const unavailableReview = {
    ...review,
    minimumOrderQuantity: 1,
    primaryPricing: { mode: 'unavailable', minimumOrderQuantity: 1 },
  };
  const doc = { alibabaPrimarySourceKey: 'linked', alibabaSourceReview: unavailableReview };
  assert.equal(productReviewCellValue(doc, 'moq'), '1 (source)');
  assert.doesNotMatch(productReviewCellValue(doc, 'pricing'), /USD|\$|Source:/);
  assert.equal(productReviewCellValue({ ...doc, unitPrice: 9, moq: 20 }, 'moq'), '20');
  assert.equal(productReviewCellValue({ ...doc, catalogPricingMode: 'manual' }, 'moq'), '—');
  for (const status of ['missing', 'MISSING'])
    assert.equal(productReviewCellValue({ ...doc, alibabaSourceStatus: status }, 'moq'), '—');
  for (const status of ['missing', 'draft'])
    assert.equal(
      productReviewCellValue(
        { ...doc, alibabaSourceReview: { ...unavailableReview, sourceListingStatus: status } },
        'moq',
      ),
      '—',
    );
  assert.equal(
    productReviewCellValue(
      { ...doc, alibabaSourceReview: { ...unavailableReview, minimumOrderQuantity: undefined } },
      'moq',
    ),
    '1 (source)',
  );
});
