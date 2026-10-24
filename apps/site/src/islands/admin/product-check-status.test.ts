import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogReadinessSchema } from '@vibelingan-channel/shared/catalog-preparation';
import {
  productCheckDefault,
  productCheckFromSearch,
  productCheckListArgs,
  productCheckPublishBlock,
  productCheckSearch,
  productClassificationCountArgs,
} from './product-check-status.ts';
test('check status URL uses a closed enum and preserves other product scope state', () => {
  for (const scope of CatalogReadinessSchema.options) {
    const before = '?productFamily=misc&subcategory=clock&unrelated=keep';
    const next = productCheckSearch(before, scope);
    assert.equal(productCheckFromSearch(next), scope);
    assert.equal(new URLSearchParams(next).get('subcategory'), 'clock');
    assert.equal(new URLSearchParams(next).get('unrelated'), 'keep');
  }
  for (const search of ['', '?checkStatus=unknown', '?checkStatus=', '?checkStatus=%5Bnormal%5D'])
    assert.equal(productCheckFromSearch(search), 'all');
  assert.equal(
    productCheckSearch('?checkStatus=issues&productFamily=toys', 'all'),
    '?productFamily=toys',
  );
});
test('only Products receive the frozen scope and classification count uses the same search/filter', () => {
  const filter = {
    combinator: 'or' as const,
    clauses: [{ field: 'name', op: 'contains' as const, value: 'Clock' }],
  };
  const args = {
    collection: 'products',
    productFamily: 'misc' as const,
    subcategoryIds: ['clock'],
    catalogReadiness: 'issues' as const,
    page: 2,
    pageSize: 20,
    filter,
    search: 'Clock',
  };
  const before = structuredClone(args);
  const scoped = productCheckListArgs(args, 'normal');
  assert.equal(scoped.catalogReadiness, 'normal');
  assert.equal(scoped.filter, filter);
  assert.deepEqual(args, before);
  const count = productClassificationCountArgs(args, 'preparing');
  assert.equal(count.catalogReadiness, 'preparing');
  assert.equal(count.page, 1);
  assert.equal(count.pageSize, 1);
  assert.equal(count.needsClassification, true);
  assert.equal(count.productFamily, undefined);
  assert.equal(count.subcategoryIds, undefined);
  assert.equal(count.filter, filter);
  assert.equal(count.search, 'Clock');
  assert.deepEqual(
    productCheckListArgs({ collection: 'users', catalogReadiness: 'issues' }, 'normal'),
    { collection: 'users' },
  );
});
test('known problem scopes have an actionable publication fallback', () => {
  for (const scope of ['issues', 'preparing', 'unchecked'] as const)
    assert.match(productCheckPublishBlock(scope) ?? '', /Preview/);
  assert.equal(productCheckPublishBlock('normal'), null);
  assert.equal(productCheckPublishBlock('all'), null);
});

test('ready default is opt-in and keeps the existing all default for every other flag value', () => {
  for (const flag of [undefined, '', '0', 'true', 'false', ' 1 ', 'normal'])
    assert.equal(productCheckDefault(flag), 'all');
  assert.equal(productCheckDefault('1'), 'normal');
  assert.equal(productCheckFromSearch('', productCheckDefault('1')), 'normal');
  assert.equal(productCheckFromSearch('?checkStatus=unknown', 'normal'), 'normal');
});

test('explicit All survives reload, history, and rollback while every problem queue remains reachable', () => {
  const original = '?productFamily=misc&subcategory=clock&keep=yes';
  for (const scope of CatalogReadinessSchema.options) {
    const search = productCheckSearch(original, scope, 'normal');
    assert.equal(productCheckFromSearch(search, 'normal'), scope);
    assert.equal(new URLSearchParams(search).get('subcategory'), 'clock');
    assert.equal(new URLSearchParams(search).get('keep'), 'yes');
    if (scope !== 'normal') assert.equal(productCheckFromSearch(search, 'all'), scope);
  }
  const all = productCheckSearch('?checkStatus=issues', 'all', 'normal');
  assert.equal(all, '?checkStatus=all');
  assert.equal(productCheckFromSearch(all, 'normal'), 'all');
  assert.equal(productCheckFromSearch(all, 'all'), 'all');
});
