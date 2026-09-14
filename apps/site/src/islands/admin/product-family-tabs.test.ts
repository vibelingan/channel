import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterModel } from '@vibelingan-channel/shared';
import {
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

test('family URL state accepts only the closed family set and omits All', () => {
  assert.equal(adminProductFamilyFromSearch('?productFamily=toys'), 'toys');
  assert.equal(adminProductFamilyFromSearch('?productFamily=garden'), null);
  assert.equal(adminProductFamilyFromSearch(''), null);
  assert.equal(
    adminProductFamilySearch('?page=3&productFamily=toys', 'ai-gadgets'),
    '?page=3&productFamily=ai-gadgets',
  );
  assert.equal(adminProductFamilySearch('?page=3&productFamily=toys', null), '?page=3');
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
