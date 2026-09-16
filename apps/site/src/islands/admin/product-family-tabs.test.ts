import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterModel } from '@vibelingan-channel/shared';
import {
  ADMIN_PRODUCT_FAMILY_LABELS,
  adminProductFamilyFromSearch,
  adminProductFamilySearch,
  productFamilyListArgs,
} from './product-family-tabs.ts';

const userFilter: FilterModel = {
  combinator: 'or',
  clauses: [
    { field: 'name', op: 'contains', value: 'camera' },
    { field: 'skuCode', op: 'startsWith', value: 'AI-' },
  ],
};

test('admin category labels match the approved website menu exactly', () => {
  assert.deepEqual(ADMIN_PRODUCT_FAMILY_LABELS, {
    headphones: 'Headphones',
    'ai-gadgets': 'AI Gadgets',
    toys: 'Toys',
    misc: 'Misc',
  });
});

test('family URL state accepts only the closed family set and omits All', () => {
  assert.equal(adminProductFamilyFromSearch('?productFamily=toys'), 'toys');
  assert.equal(adminProductFamilyFromSearch('?productFamily=unclassified'), 'unclassified');
  assert.equal(adminProductFamilyFromSearch('?productFamily=garden'), null);
  assert.equal(adminProductFamilyFromSearch(''), null);
  assert.equal(
    adminProductFamilySearch('?page=3&productFamily=toys', 'ai-gadgets'),
    '?page=3&productFamily=ai-gadgets',
  );
  assert.equal(adminProductFamilySearch('?page=3&productFamily=toys', null), '?page=3');
});

test('unclassified is a query scope, never a persisted family or a replacement for user filters', () => {
  const args = productFamilyListArgs(
    { collection: 'products', filter: userFilter, page: 2 },
    'unclassified',
  );
  assert.equal(args.needsClassification, true);
  assert.equal(args.productFamily, undefined);
  assert.equal(args.filter, userFilter);
  assert.equal(args.page, 2);
  assert.equal(
    productFamilyListArgs({ collection: 'users' }, 'unclassified').needsClassification,
    undefined,
  );
});

test('family list args preserve search, OR filter, sort, and pagination independently', () => {
  const args = productFamilyListArgs(
    {
      collection: 'products',
      page: 4,
      pageSize: 20,
      search: 'smart',
      filter: userFilter,
      sort: [{ field: 'updatedAt', dir: 'desc' }],
    },
    'ai-gadgets',
  );
  assert.equal(args.productFamily, 'ai-gadgets');
  assert.equal(args.page, 4);
  assert.equal(args.search, 'smart');
  assert.equal(args.filter, userFilter);
  assert.deepEqual(args.sort, [{ field: 'updatedAt', dir: 'desc' }]);
});

test('non-product collections never receive a family query', () => {
  const args = productFamilyListArgs({ collection: 'users', page: 1, pageSize: 20 }, 'toys');
  assert.equal(args.productFamily, undefined);
});

test('a new scope clears stale flags when returning to All or another family', () => {
  const old = { collection: 'products', productFamily: 'toys' as const, needsClassification: true };
  assert.deepEqual(productFamilyListArgs(old, null), { collection: 'products' });
  assert.deepEqual(productFamilyListArgs(old, 'headphones'), {
    collection: 'products',
    productFamily: 'headphones',
  });
  assert.deepEqual(productFamilyListArgs(old, 'unclassified'), {
    collection: 'products',
    needsClassification: true,
  });
});
