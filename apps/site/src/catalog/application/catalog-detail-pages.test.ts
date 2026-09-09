import assert from 'node:assert/strict';
import test from 'node:test';
import { detailFixture } from '../testing/detail-fixture.ts';
import { acceptDetailPage, startDetailPages } from './catalog-detail-pages.ts';

test('structured content cannot change or downgrade in the middle of revision paging', () => {
  const content = {
    schemaVersion: 'catalog-content-v1',
    specifications: [],
    packaging: [],
    notes: ['Source notes'],
  };
  const first = startDetailPages(
    { ...detailFixture(51), schemaVersion: 'catalog-product-detail-v2', content },
    1000,
  );
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') throw Error('fixture');
  const next = { ...detailFixture(51, 2), schemaVersion: 'catalog-product-detail-v2', content };
  assert.equal(acceptDetailPage(first.value, next, 1000).status, 'ready');
  assert.equal(
    acceptDetailPage(first.value, { ...next, content: { ...content, notes: ['Changed'] } }, 1000)
      .status,
    'refresh-required',
  );
  assert.equal(
    acceptDetailPage(first.value, detailFixture(51, 2), 1000).status,
    'refresh-required',
  );
});

test('loads variant 51 without claiming the first 50 are complete', () => {
  const first = startDetailPages(detailFixture(51), 1000);
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') return;
  assert.equal(first.value.mode, 'collecting');
  assert.equal(first.value.items.length, 50);
  const second = acceptDetailPage(first.value, detailFixture(51, 2), 200);
  assert.equal(second.status, 'ready');
  if (second.status !== 'ready') return;
  assert.equal(second.value.mode, 'complete');
  assert.equal(second.value.items.length, 51);
  assert.equal(second.value.items[50]?.id, 'variant-51');
  assert.equal(first.value.items.length, 50, 'input state is not mutated');
});

test('empty approved product is complete, not an error or a synthetic variant', () => {
  const result = startDetailPages(detailFixture(0), 100);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.value.mode, 'complete');
  assert.equal(result.value.items.length, 0);
});

test('rejects mixed revision total header and product without returning stale data', () => {
  const first = startDetailPages(detailFixture(51), 100);
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') return;
  for (const data of [
    { ...detailFixture(51, 2), revision: 'r2' },
    { ...detailFixture(51, 2), name: 'Changed header' },
    { ...detailFixture(51, 2), _id: 'foreign' },
    detailFixture(52, 2),
  ])
    assert.deepEqual(acceptDetailPage(first.value, data, 100), { status: 'refresh-required' });
});

test('rejects missing revision invalid DTO and out-of-range initial page', () => {
  for (const data of [
    null,
    '',
    { ...detailFixture(), revision: undefined },
    detailFixture(51, 2),
    { ...detailFixture(), rawPayload: 'private' },
  ])
    assert.deepEqual(startDetailPages(data, 100), { status: 'invalid-response' });
});

test('rejects duplicate IDs across collected pages, skipped pages and changed page size', () => {
  const first = startDetailPages(detailFixture(151), 100);
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') return;
  const duplicate = detailFixture(151, 2);
  const variant = duplicate.variants.items[0];
  assert.ok(variant);
  variant.id = 'variant-1';
  for (const data of [duplicate, detailFixture(151, 3), detailFixture(151, 2, 25)]) {
    assert.deepEqual(acceptDetailPage(first.value, data, 100), { status: 'invalid-response' });
  }
});

test('large products remain pageable without retaining an unbounded variant array', () => {
  let result = startDetailPages(detailFixture(501), 1000);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.value.mode, 'paged');
  result = acceptDetailPage(result.value, detailFixture(501, 11), 200);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.value.mode, 'paged', 'last page alone is not complete product coverage');
  assert.equal(result.value.items.length, 1);
  assert.equal(result.value.items[0]?.id, 'variant-501');
  assert.equal(result.value.retainedBytes, 200);
  result = acceptDetailPage(result.value, detailFixture(501, 1), 1000);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.value.items.length, 50);
  assert.deepEqual(acceptDetailPage(result.value, detailFixture(501, 12), 100), {
    status: 'invalid-response',
  });
});

test('enforces page and accumulated byte budgets without silently truncating records', () => {
  for (const bytes of [0, -1, Number.NaN, 0.5, 2 * 1024 * 1024 + 1]) {
    assert.deepEqual(startDetailPages(detailFixture(), bytes), { status: 'limit-exceeded' });
  }
  let result = startDetailPages(detailFixture(251), 2 * 1024 * 1024);
  for (let page = 2; page <= 4; page++) {
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    result = acceptDetailPage(result.value, detailFixture(251, page), 2 * 1024 * 1024);
  }
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(acceptDetailPage(result.value, detailFixture(251, 5), 1), {
    status: 'limit-exceeded',
  });
});

test('a small requested page size still respects the ten-page collection budget', () => {
  const result = startDetailPages(detailFixture(11, 1, 1), 100);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.value.mode, 'paged');
});
