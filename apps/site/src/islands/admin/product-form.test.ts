import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCollection } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { availableImageSlots, boundedSelectedFiles, reorderImageIds } from './ImageManager.tsx';
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
  assert.equal(editableNames.includes('vipPrice'), false);
  assert.equal(
    editableNames.some((name) => name.startsWith('alibaba')),
    false,
  );
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
  });
  assert.match(markup, /Identity|Content|Media|Pricing &amp; Order|Lifecycle/);
  assert.match(markup, /Primary/);
  assert.match(markup, /Alibaba Source|available|2026-08-20/);
  assert.doesNotMatch(markup, /VIP Price/);
  assert.equal(availableImageSlots(9, 8, 1), 0);
  assert.equal(availableImageSlots(9, 8, 0), 1);
  const files = [new File(['a'], 'a.png'), new File(['b'], 'b.png')];
  assert.deepEqual(boundedSelectedFiles(files, availableImageSlots(9, 8, 0)), [files[0]]);
  assert.equal(availableImageSlots(9, 8, 1), 0, 'pending upload consumes the final slot');
  assert.deepEqual(reorderImageIds(['one', 'two', 'three'], 'two', -1), ['two', 'one', 'three']);
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
