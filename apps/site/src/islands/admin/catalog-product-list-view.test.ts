import assert from 'node:assert/strict';
import test from 'node:test';
import { type CollectionDoc, productFamilyForDoc } from '@vibelingan-channel/shared';
import { projectProductListRow } from '../../../../../packages/db/src/catalog-product-list-view.ts';
import { productReviewCellValue } from './alibaba-source-review.ts';
import { categorySuggestionMatchesProduct } from './api.ts';
import { productThumbnailSource } from './product-thumbnail.ts';
import { reviewLabel, splitForBatchPublish } from './review-reason.ts';
const url = (id: string) => `https://sc04.alicdn.com/kf/${id}.jpg`;
const sourceReview = {
  schemaVersion: 'alibaba-source-review-v1',
  provider: 'alibaba',
  externalProductId: 'external',
  sourceCategoryId: 'source-category',
  sourceCategoryName: 'Clocks',
  sourceListingStatus: 'published',
  variantCount: 3,
  offerCount: 4,
  modelNumbers: ['T142', 'T157'],
  optionNames: ['Color'],
  minimumOrderQuantity: 2,
  primaryPricing: { mode: 'fixed', currency: 'USD', amountMinor: 299, minimumOrderQuantity: 2 },
};
const source = {
  schemaVersion: 'alibaba-catalog-pricing-v1',
  source: 'alibaba',
  currency: 'USD',
  sourceMoq: 2,
  syncedAt: '2026-10-18T00:00:00.000Z',
};
const base: CollectionDoc = {
  _id: 'p',
  name: 'Clock',
  productFamily: 'misc',
  category: 'Wired Headphones',
  subcategoryIds: ['clock'],
  published: false,
  updatedAt: 'version',
  alibabaReviewPending: true,
  alibabaReviewReason: 'new',
  alibabaSourceReview: sourceReview,
  alibabaPrimarySourceKey: 'source-key',
  imageIds: ['im-2', 'im-3'],
  alibabaAutoPhotos: {
    gallery: {
      sources: [url('g1'), url('g2'), url('g3')],
      imageIds: ['im-2', 'im-3'],
      unusable: [url('g1')],
      missing: [],
    },
    description: { private: 'never-list' },
  },
  alibabaSourceImageUrls: [url('fallback')],
  description: 'private-description',
  catalogPublication: { private: 'never-list' },
};
const cases: Record<string, Partial<CollectionDoc>> = {
  fixed: { alibabaCatalogPricing: { ...source, mode: 'fixed', amountMinor: 234 } },
  range: {
    alibabaCatalogPricing: { ...source, mode: 'range', minAmountMinor: 100, maxAmountMinor: 345 },
  },
  tiered: {
    alibabaCatalogPricing: {
      ...source,
      mode: 'tiered',
      tiers: [
        { minQuantity: 2, maxQuantity: 99, unitAmountMinor: 299 },
        { minQuantity: 100, unitAmountMinor: 199 },
      ],
    },
  },
  manual: {
    catalogPricingMode: 'manual',
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [{ minQuantity: 3, unitAmountMinor: 456 }],
    },
  },
  scalar: { alibabaPrimarySourceKey: undefined, unitPrice: 3.1, wholesalePrice: 2.9, moq: 50 },
  'source-fallback': {},
  'missing-source': { alibabaSourceStatus: 'missing', alibabaReviewReason: 'removed' },
  changed: { alibabaReviewReason: 'changed', skuCode: 'sku', modName: 'Model X' },
  published: { published: true },
  'manual-photo': { imageIds: ['own'], alibabaReviewReason: 'edited' },
  'source-photo': { imageIds: [] },
  'legacy-family': { productFamily: undefined },
};
for (const [name, values] of Object.entries(cases))
  test(`list projection preserves existing consumer behavior: ${name}`, () => {
    const raw = { ...base, ...values };
    if (name === 'legacy-family') Reflect.deleteProperty(raw, 'productFamily');
    const before = JSON.stringify(raw);
    const projected = projectProductListRow(raw);
    for (const cell of ['identity', 'category', 'model', 'variants', 'moq', 'pricing'] as const)
      assert.equal(
        productReviewCellValue(projected, cell),
        productReviewCellValue(raw, cell),
        cell,
      );
    assert.equal(
      productReviewCellValue(projected, 'identity'),
      name === 'changed' ? 'sku' : 'external',
    );
    assert.equal(productReviewCellValue(projected, 'variants'), '3 variants · 4 offers');
    assert.notEqual(productReviewCellValue(projected, 'pricing'), '—');
    if (['fixed', 'range', 'tiered', 'manual', 'scalar', 'source-fallback'].includes(name))
      assert.notEqual(productReviewCellValue(projected, 'pricing'), 'Request a quote');
    assert.deepEqual(productThumbnailSource(projected), productThumbnailSource(raw));
    assert.ok(productThumbnailSource(projected));
    assert.equal(reviewLabel(projected), reviewLabel(raw));
    assert.equal(productFamilyForDoc(projected), productFamilyForDoc(raw));
    assert.deepEqual(
      splitForBatchPublish([projected]).map((rows) => rows.map((row) => row._id)),
      splitForBatchPublish([raw]).map((rows) => rows.map((row) => row._id)),
    );
    for (const key of [
      'subcategoryIds',
      'published',
      'updatedAt',
      'archived',
      'alibabaPrimarySourceKey',
    ])
      assert.deepEqual(projected[key], raw[key], key);
    assert.equal(projected.description, undefined);
    assert.equal(projected.catalogPublication, undefined);
    assert.equal(JSON.stringify(raw), before);
  });

test('limited list metadata is labelled as full-read details rather than a false price or photo', () => {
  const row = { ...projectProductListRow(base), _adminProductListLimited: true };
  for (const cell of ['identity', 'category', 'model', 'variants', 'moq', 'pricing'] as const)
    assert.equal(productReviewCellValue(row, cell), 'View in Preview');
  assert.equal(productThumbnailSource(row), null);
});
for (const mode of ['nested-only', 'direct-only', 'matching', 'mismatch'] as const)
  test(`limited metadata retains exact source suggestion identity: ${mode}`, () => {
    const reviewData = {
      ...sourceReview,
      sourceCategoryId: '123',
      modelNumbers: Array.from({ length: 100 }, () => '中'.repeat(256)),
      optionNames: Array.from({ length: 100 }, () => '中'.repeat(256)),
    };
    const raw: CollectionDoc = {
      ...base,
      updatedAt: '2026-10-18T00:00:00.000Z',
      alibabaSourceReview: reviewData,
    };
    if (mode === 'direct-only') Reflect.deleteProperty(reviewData, 'sourceCategoryId');
    if (mode !== 'nested-only')
      Reflect.set(raw, 'alibabaSourceCategoryId', mode === 'mismatch' ? '456' : '123');
    const row = projectProductListRow(raw);
    const suggestion: Parameters<typeof categorySuggestionMatchesProduct>[0] = {
      kind: 'suggestion',
      status: 'ready',
      productId: raw._id,
      productUpdatedAt: '2026-10-18T00:00:00.000Z',
      source: { primarySourceKey: 'source-key', sourceCategoryId: '123' },
      mapping: { id: 'mapping', revision: 'a'.repeat(64) },
      family: 'misc',
      subcategoryIds: ['clock'],
      taxonomyRevision: 1,
    };
    assert.equal(
      categorySuggestionMatchesProduct(suggestion, row),
      categorySuggestionMatchesProduct(suggestion, raw),
    );
    assert.equal(categorySuggestionMatchesProduct(suggestion, row), mode !== 'mismatch');
  });
