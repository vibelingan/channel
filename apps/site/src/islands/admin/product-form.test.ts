import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCollection } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { availableImageSlots, boundedSelectedFiles, reorderImageIds } from './ImageManager.tsx';
import {
  decodeManualPricing,
  parseMajorAmountToMinor,
  updateManualPricingTier,
} from './QuantityTierPricingEditor.tsx';
import {
  RecordForm,
  coerceValues,
  productEditableFields,
  productFamilyTransition,
  productFormErrorTargets,
  productFormSections,
  productReadOnlyFields,
} from './RecordForm.tsx';
import { AdminApiError } from './api.ts';

const products = getCollection('products');
const users = getCollection('users');
assert.ok(products);
assert.ok(users);

const renderForm = (
  collection = products,
  initial: Record<string, unknown> | undefined = undefined,
  error: Error | null = null,
) =>
  renderToStaticMarkup(
    createElement(RecordForm, {
      collection,
      title: 'Edit Product',
      ...(initial ? { initial: { _id: 'product-1', ...initial } } : {}),
      submitting: false,
      error,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    }),
  );

test('product fields are grouped and editable controls exclude VIP and Alibaba ownership', () => {
  const sections = productFormSections(products);
  assert.deepEqual(
    sections.map((section) => section.heading),
    ['Identity', 'Content', 'Media', 'Pricing & Order', 'Lifecycle'],
  );
  const editableNames = productEditableFields(products).map((field) => field.name);
  assert.ok(editableNames.includes('productFamily'));
  assert.ok(editableNames.includes('category'));
  assert.ok(editableNames.includes('imageIds'));
  assert.ok(editableNames.includes('manualCatalogPricing'));
  assert.equal(editableNames.includes('vipPrice'), false);
  assert.equal(
    editableNames.some((name) => name.startsWith('alibaba')),
    false,
  );
});

test('manual tier editor parses currency exactly and updates rows without touching scalars', () => {
  assert.equal(parseMajorAmountToMinor('134.18'), 13_418);
  assert.equal(parseMajorAmountToMinor('0'), 0);
  assert.equal(parseMajorAmountToMinor('1.2'), 120);
  assert.equal(parseMajorAmountToMinor('1.234'), null);
  assert.equal(parseMajorAmountToMinor('-1'), null);

  const pricing = decodeManualPricing('');
  assert.equal(pricing.currency, 'USD');
  assert.deepEqual(pricing.tiers, []);
  assert.deepEqual(updateManualPricingTier(pricing, 0, 'minQuantity', '1').tiers, [
    { minQuantity: 1, unitAmountMinor: 0 },
  ]);
});

test('family transition clears Headphones-only subcategory and announces the move', () => {
  assert.deepEqual(
    productFamilyTransition({ productFamily: 'headphones', category: 'office' }, 'toys'),
    {
      patch: { productFamily: 'toys', category: '' },
      announcement: 'Subcategory cleared because it applies only to Headphones.',
    },
  );
  assert.deepEqual(
    productFamilyTransition({ productFamily: 'headphones', category: 'wired' }, 'headphones'),
    {
      patch: { productFamily: 'headphones' },
      announcement: '',
    },
  );
});

test('server identity and publication errors target relevant product fields', () => {
  assert.deepEqual(
    productFormErrorTargets(
      new AdminApiError('CONFLICT', 'Product slug is already in use: camera'),
    ),
    { slug: 'Product slug is already in use: camera' },
  );
  assert.deepEqual(
    productFormErrorTargets(
      new AdminApiError(
        'VALIDATION_ERROR',
        'SKU code is required to publish; At least one product image is required to publish',
      ),
    ),
    {
      skuCode: 'SKU code is required to publish',
      imageIds: 'At least one product image is required to publish',
    },
  );
});

test('product form renders sections, primary image semantics, and read-only Alibaba status', () => {
  const markup = renderForm(products, {
    name: 'Camera',
    productFamily: 'ai-gadgets',
    imageIds: ['image-1'],
    alibabaSourceStatus: 'available',
    alibabaSourceLastSyncedAt: '2026-08-20T00:00:00.000Z',
    alibabaSourceImageUrls: ['https://sc04.alicdn.com/product.jpg'],
  });
  assert.match(markup, /Identity|Content|Media|Pricing &amp; Order|Lifecycle/);
  assert.match(markup, /Primary/);
  assert.match(markup, /Alibaba Source|available|2026-08-20/);
  assert.match(markup, /Import primary image/);
  assert.match(markup, /referrerpolicy="no-referrer"/i);
  assert.doesNotMatch(markup, /VIP Price/);
  assert.doesNotMatch(markup, /Subcategory/);
  assert.match(markup, /Quantity Tier Pricing|Add price tier/);
  assert.equal(availableImageSlots(9, 8, 1), 0);
  assert.equal(availableImageSlots(9, 8, 0), 1);
  const files = [new File(['a'], 'a.png'), new File(['b'], 'b.png')];
  assert.deepEqual(boundedSelectedFiles(files, availableImageSlots(9, 8, 0)), [files[0]]);
  assert.equal(availableImageSlots(9, 8, 1), 0, 'pending upload consumes the final slot');
  assert.deepEqual(reorderImageIds(['one', 'two', 'three'], 'two', -1), ['two', 'one', 'three']);
});

test('subcategory renders only for Headphones products', () => {
  assert.match(renderForm(products, { productFamily: 'headphones' }), /Subcategory/);
  for (const productFamily of ['ai-gadgets', 'toys', 'misc']) {
    assert.doesNotMatch(renderForm(products, { productFamily }), /Subcategory/);
  }
});

test('coercion preserves image order and cannot submit hidden VIP values', () => {
  const values = coerceValues(products, {
    name: 'Camera',
    productFamily: 'ai-gadgets',
    imageIds: '["image-2","image-1"]',
    vipPrice: '99',
    published: false,
    archived: false,
  });
  assert.deepEqual(values.imageIds, ['image-2', 'image-1']);
  assert.equal(Object.hasOwn(values, 'vipPrice'), false);
});

test('coercion omits non-Headphones subcategory and clears only existing tier pricing', () => {
  const values = coerceValues(products, {
    name: 'Toy',
    productFamily: 'toys',
    category: 'wired',
    manualCatalogPricing: '',
    published: false,
    archived: false,
  });
  assert.equal(Object.hasOwn(values, 'category'), false);
  assert.equal(Object.hasOwn(values, 'manualCatalogPricing'), false);
  const cleared = coerceValues(
    products,
    {
      name: 'Toy',
      productFamily: 'toys',
      manualCatalogPricing: '',
      published: false,
      archived: false,
    },
    {
      _id: 'toy-1',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
      },
    },
  );
  assert.equal(cleared.manualCatalogPricing, null);

  const moved = coerceValues(
    products,
    {
      name: 'Moved product',
      productFamily: 'toys',
      category: '',
      published: false,
      archived: false,
    },
    { _id: 'headphone-1', productFamily: 'headphones', category: 'wired' },
  );
  assert.equal(moved.category, '');

  const movedLegacy = coerceValues(
    products,
    {
      name: 'Legacy moved',
      productFamily: 'toys',
      category: '',
      published: false,
      archived: false,
    },
    { _id: 'legacy-1', category: 'office' },
  );
  assert.equal(movedLegacy.category, '');
});

test('tier editor renders field-specific accessible errors without raw JSON controls', () => {
  const markup = renderForm(
    products,
    { productFamily: 'toys', manualCatalogPricing: { invalid: true } },
    new AdminApiError('VALIDATION_ERROR', 'Tier pricing must be valid'),
  );
  assert.match(markup, /Quantity Tier Pricing/);
  assert.match(markup, /manualCatalogPricing-error|Tier pricing must be valid/);
  assert.doesNotMatch(markup, /manualCatalogPricing[^>]*textarea/);
});

test('stored cleared tier pricing reopens as an empty valid editor', () => {
  const markup = renderForm(products, {
    name: 'Cleared product',
    productFamily: 'toys',
    manualCatalogPricing: '',
  });
  assert.match(markup, /Quantity Tier Pricing|Add price tier/);
  assert.doesNotMatch(markup, /Stored tier pricing is malformed/);
  assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*>Save<\/button>/);
});

test('non-product forms keep their ordinary editable fields and no product sections', () => {
  const markup = renderForm(users, { email: 'user@example.test', role: 'member' });
  assert.match(markup, /Email|Role/);
  assert.doesNotMatch(markup, /Identity|Pricing &amp; Order|Alibaba Source/);
  assert.deepEqual(productReadOnlyFields(users, { _id: 'user-1' }), []);
});

test('archived publication errors target the lifecycle control', () => {
  assert.deepEqual(
    productFormErrorTargets(
      new AdminApiError('VALIDATION_ERROR', 'Archived products cannot be published'),
    ),
    { archived: 'Archived products cannot be published' },
  );
});
