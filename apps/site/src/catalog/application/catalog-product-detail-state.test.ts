import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DetailPageResult } from '../infrastructure/catalog-detail-api.ts';
import { detailFixture } from '../testing/detail-fixture.ts';
import {
  type ProductDetailState,
  initialProductDetailState,
  reduceProductDetail,
} from './catalog-product-detail-state.ts';

function response(
  total = 3,
  page = 1,
  productId = 'A',
  revision = 'approved-r1',
): DetailPageResult {
  return {
    status: 'ready',
    detail: { ...detailFixture(total, page), _id: productId, revision },
    bytes: 1000,
  };
}
function open(total = 3, requestedId?: string) {
  const loading = reduceProductDetail(initialProductDetailState(), {
    type: 'open',
    generation: 1,
    productId: 'A',
    requestedId,
  });
  return ready(
    reduceProductDetail(loading, {
      type: 'result',
      generation: 1,
      productId: 'A',
      result: response(total),
    }),
  );
}
function ready(state: ProductDetailState) {
  assert.equal(state.status, 'ready');
  if (state.status !== 'ready') throw new Error('Expected ready');
  return state;
}

test('ignores late product A after B and late success after close', () => {
  const a = reduceProductDetail(initialProductDetailState(), {
    type: 'open',
    generation: 1,
    productId: 'A',
  });
  const b = reduceProductDetail(a, { type: 'open', generation: 2, productId: 'B' });
  assert.strictEqual(
    reduceProductDetail(b, { type: 'result', generation: 1, productId: 'A', result: response() }),
    b,
  );
  assert.strictEqual(
    reduceProductDetail(b, { type: 'result', generation: 2, productId: 'A', result: response() }),
    b,
  );
  const closed = reduceProductDetail(b, { type: 'close', generation: 3 });
  assert.deepEqual(closed, { status: 'idle', generation: 3 });
  assert.strictEqual(
    reduceProductDetail(closed, {
      type: 'result',
      generation: 2,
      productId: 'B',
      result: response(3, 1, 'B'),
    }),
    closed,
  );
});

test('keeps URL selection pending until later page arrives; invalid URL needs completed coverage', () => {
  const first = open(51, 'variant-51');
  assert.deepEqual(first.selection, { status: 'pending', requestedId: 'variant-51' });
  const next = reduceProductDetail(first, { type: 'page', generation: 2, page: 2 });
  assert.equal(next.status, 'ready');
  if (next.status === 'ready')
    assert.deepEqual(next.request, {
      productId: 'A',
      page: 2,
      pageSize: 50,
      revision: 'approved-r1',
    });
  const last = ready(
    reduceProductDetail(next, {
      type: 'result',
      generation: 2,
      productId: 'A',
      result: response(51, 2),
    }),
  );
  assert.equal(last.selection.status, 'selected');
  if (last.selection.status === 'selected') assert.equal(last.selection.variant.id, 'variant-51');
  const missing = open(51, 'missing');
  const searched = ready(
    reduceProductDetail(reduceProductDetail(missing, { type: 'page', generation: 2, page: 2 }), {
      type: 'result',
      generation: 2,
      productId: 'A',
      result: response(51, 2),
    }),
  );
  assert.deepEqual(searched.selection, { status: 'invalid', requestedId: 'missing' });
});

test('paged last page is not complete coverage; explicit selection clears pending', () => {
  const first = open(501, 'missing');
  const last = ready(
    reduceProductDetail(reduceProductDetail(first, { type: 'page', generation: 2, page: 11 }), {
      type: 'result',
      generation: 2,
      productId: 'A',
      result: response(501, 11),
    }),
  );
  assert.deepEqual(last.selection, { status: 'pending', requestedId: 'missing' });
  const chosen = ready(
    reduceProductDetail(last, {
      type: 'select',
      productId: 'A',
      revision: 'approved-r1',
      variantId: 'variant-501',
    }),
  );
  assert.equal(chosen.selection.status, 'selected');
  const cleared = ready(
    reduceProductDetail(first, { type: 'select', productId: 'A', revision: 'approved-r1' }),
  );
  assert.deepEqual(cleared.selection, { status: 'unselected' });
});

test('paged navigation retains current page plus selected snapshot and ignores older page response', () => {
  const selected = ready(
    reduceProductDetail(open(501), {
      type: 'select',
      productId: 'A',
      revision: 'approved-r1',
      variantId: 'variant-1',
    }),
  );
  const page2 = reduceProductDetail(selected, { type: 'page', generation: 2, page: 2 });
  const page3 = reduceProductDetail(page2, { type: 'page', generation: 3, page: 3 });
  assert.strictEqual(
    reduceProductDetail(page3, {
      type: 'result',
      generation: 2,
      productId: 'A',
      result: response(501, 2),
    }),
    page3,
  );
  const loaded = ready(
    reduceProductDetail(page3, {
      type: 'result',
      generation: 3,
      productId: 'A',
      result: response(501, 3),
    }),
  );
  assert.equal(loaded.pages.items.length, 50);
  assert.equal(loaded.pages.items[0].id, 'variant-101');
  assert.equal(loaded.selection.status, 'selected');
  if (loaded.selection.status === 'selected')
    assert.equal(loaded.selection.variant.id, 'variant-1');
  assert.equal(loaded.request, undefined);
});

test('retryable page failure retains same revision; 409 and invalid pages discard stale selection', () => {
  const first = open(51, 'variant-1');
  const pending = reduceProductDetail(first, { type: 'page', generation: 2, page: 2 });
  const failed = ready(
    reduceProductDetail(pending, {
      type: 'result',
      generation: 2,
      productId: 'A',
      result: { status: 'network-error' },
    }),
  );
  assert.strictEqual(failed.pages, first.pages);
  assert.deepEqual(failed.pageError, { error: { status: 'network-error' }, page: 2 });
  const retry = reduceProductDetail(failed, { type: 'page', generation: 3, page: 2 });
  assert.equal(
    ready(
      reduceProductDetail(retry, {
        type: 'result',
        generation: 3,
        productId: 'A',
        result: response(51, 2),
      }),
    ).pages.mode,
    'complete',
  );
  for (const result of [
    { status: 'refresh-required' } as const,
    response(51, 2, 'A', 'approved-r2'),
    response(51, 2, 'B'),
  ]) {
    const state = reduceProductDetail(pending, {
      type: 'result',
      generation: 2,
      productId: 'A',
      result,
    });
    assert.equal(state.status, 'error');
    assert.equal('pages' in state, false);
    assert.equal('selection' in state, false);
  }
});

test('request identity includes page and size; consumed responses cannot be applied twice', () => {
  const first = open(51);
  assert.strictEqual(
    reduceProductDetail(first, {
      type: 'result',
      generation: 1,
      productId: 'A',
      result: response(51),
    }),
    first,
  );
  const pending = reduceProductDetail(first, { type: 'page', generation: 2, page: 2 });
  const mismatch = reduceProductDetail(pending, {
    type: 'result',
    generation: 2,
    productId: 'A',
    result: response(51, 1),
  });
  assert.equal(mismatch.status, 'error');
  if (mismatch.status === 'error') assert.equal(mismatch.error.status, 'invalid-response');
});

test('rejects stale UI choices and invalid page or generation transitions without changing state', () => {
  const state = open(51);
  for (const generation of [0, 1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.strictEqual(
      reduceProductDetail(state, { type: 'open', generation, productId: 'B' }),
      state,
    );
  }
  for (const page of [0, 1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.strictEqual(reduceProductDetail(state, { type: 'page', generation: 2, page }), state);
  }
  for (const [productId, revision, variantId] of [
    ['B', 'approved-r1', 'variant-1'],
    ['A', 'old', 'variant-1'],
    ['A', 'approved-r1', 'missing'],
  ]) {
    assert.strictEqual(
      reduceProductDetail(state, { type: 'select', productId, revision, variantId }),
      state,
    );
  }
});

test('refresh clears prior selection and initial errors expose no fabricated product', () => {
  const current = open(3, 'variant-3');
  const refresh = reduceProductDetail(current, { type: 'open', generation: 2, productId: 'A' });
  assert.equal(refresh.status, 'loading');
  assert.equal('selection' in refresh, false);
  const failure = reduceProductDetail(refresh, {
    type: 'result',
    generation: 2,
    productId: 'A',
    result: { status: 'not-found' },
  });
  assert.equal(failure.status, 'error');
  assert.equal('pages' in failure, false);
  const empty = open(0);
  assert.equal(empty.selection.status, 'none');
});

test('a selected snapshot cannot silently change under the same revision on return', () => {
  const selected = ready(
    reduceProductDetail(open(501), {
      type: 'select',
      productId: 'A',
      revision: 'approved-r1',
      variantId: 'variant-1',
    }),
  );
  const page2 = ready(
    reduceProductDetail(reduceProductDetail(selected, { type: 'page', generation: 2, page: 2 }), {
      type: 'result',
      generation: 2,
      productId: 'A',
      result: response(501, 2),
    }),
  );
  const back = reduceProductDetail(page2, { type: 'page', generation: 3, page: 1 });
  const changed = response(501);
  assert.equal(changed.status, 'ready');
  if (changed.status !== 'ready') throw new Error('Expected fixture');
  changed.detail.variants.items[0].options = [{ name: 'Color', value: 'Changed' }];
  const rejected = reduceProductDetail(back, {
    type: 'result',
    generation: 3,
    productId: 'A',
    result: changed,
  });
  assert.equal(rejected.status, 'error');
  if (rejected.status === 'error') assert.equal(rejected.error.status, 'refresh-required');
  const unchanged = ready(
    reduceProductDetail(back, {
      type: 'result',
      generation: 3,
      productId: 'A',
      result: response(501),
    }),
  );
  assert.equal(unchanged.selection.status, 'selected');
});

test('explicit choice made during a page request survives completion and does not mutate prior state', () => {
  const first = open(51, 'variant-51');
  const before = JSON.stringify(first);
  const pending = reduceProductDetail(first, { type: 'page', generation: 2, page: 2 });
  const chosen = reduceProductDetail(pending, {
    type: 'select',
    productId: 'A',
    revision: 'approved-r1',
    variantId: 'variant-2',
  });
  const complete = ready(
    reduceProductDetail(chosen, {
      type: 'result',
      generation: 2,
      productId: 'A',
      result: response(51, 2),
    }),
  );
  assert.equal(complete.selection.status, 'selected');
  if (complete.selection.status === 'selected')
    assert.equal(complete.selection.variant.id, 'variant-2');
  assert.equal(JSON.stringify(first), before);
});
