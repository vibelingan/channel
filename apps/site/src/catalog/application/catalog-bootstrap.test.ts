import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailFixture } from '../testing/detail-fixture.ts';
import {
  initialProductDetailState,
  productDetailFreshness,
  reduceProductDetail,
} from './catalog-product-detail-state.ts';

test('bootstrap is ready on the initial render and rejects invalid or private detail data', () => {
  const state = initialProductDetailState(detailFixture());
  assert.equal(state.status, 'ready');
  assert.throws(() => initialProductDetailState({ ...detailFixture(), adminSecret: 'secret' }));
});

test('background refresh retains the body on transient failure and replaces a changed revision atomically', () => {
  const initial = initialProductDetailState(detailFixture());
  const refreshing = reduceProductDetail(initial, { type: 'refresh', generation: 1 });
  assert.equal(refreshing.status, 'ready');
  const failed = reduceProductDetail(refreshing, {
    type: 'result',
    productId: 'canonical-product',
    generation: 1,
    result: { status: 'network-error' },
  });
  assert.equal(failed.status, 'ready');
  const next = reduceProductDetail(refreshing, {
    type: 'result',
    productId: 'canonical-product',
    generation: 1,
    result: { status: 'ready', detail: { ...detailFixture(), revision: 'new-r2' }, bytes: 1000 },
  });
  assert.equal(next.status, 'ready');
  if (next.status === 'ready') assert.equal(next.pages.currentPage.revision, 'new-r2');
  const removed = reduceProductDetail(refreshing, {
    type: 'result',
    productId: 'canonical-product',
    generation: 1,
    result: { status: 'not-found' },
  });
  assert.equal(removed.status, 'error');
});

test('pagination after a failed refresh keeps the pinned page protocol instead of restarting at page two', () => {
  const initial = initialProductDetailState(detailFixture(501));
  const refreshing = reduceProductDetail(initial, { type: 'refresh', generation: 1 });
  const failed = reduceProductDetail(refreshing, {
    type: 'result',
    productId: 'canonical-product',
    generation: 1,
    result: { status: 'unavailable' },
  });
  const next = reduceProductDetail(failed, { type: 'page', generation: 2, page: 2 });
  const accepted = reduceProductDetail(next, {
    type: 'result',
    productId: 'canonical-product',
    generation: 2,
    result: {
      status: 'ready',
      detail: { ...detailFixture(501, 2), revision: 'approved-r1' },
      bytes: 1000,
    },
  });
  assert.equal(accepted.status, 'ready');
  if (accepted.status === 'ready') assert.equal(accepted.pages.currentPage.variants.page, 2);
});

test('only a fully decoded and applied browser result is fresh; snapshot, in-flight and failed reads are distinct', () => {
  const initial = initialProductDetailState(detailFixture());
  assert.equal(productDetailFreshness(initial), 'snapshot');
  const pending = reduceProductDetail(initial, { type: 'refresh', generation: 1 });
  assert.equal(productDetailFreshness(pending), 'loading');
  const failed = reduceProductDetail(pending, {
    type: 'result',
    productId: 'canonical-product',
    generation: 1,
    result: { status: 'network-error' },
  });
  assert.equal(productDetailFreshness(failed), 'error');
  const ready = reduceProductDetail(pending, {
    type: 'result',
    productId: 'canonical-product',
    generation: 1,
    result: { status: 'ready', detail: { ...detailFixture(), revision: 'new-r2' }, bytes: 1000 },
  });
  assert.equal(productDetailFreshness(ready), 'fresh');
  assert.equal(
    productDetailFreshness(
      reduceProductDetail(pending, {
        type: 'result',
        productId: 'canonical-product',
        generation: 1,
        result: { status: 'invalid-response' },
      }),
    ),
    'error',
  );
});
