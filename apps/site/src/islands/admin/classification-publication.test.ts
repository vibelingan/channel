import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CatalogClassificationAssignmentRequest,
  CatalogClassificationAssignmentResult,
} from '@vibelingan-channel/shared';
import {
  matchesVerifiedOutcome,
  unresolvedClassificationSnapshot,
} from './ProductClassificationEditor.tsx';
import { AdminApiError, assignmentCall, fetchCatalogDetailCapabilities } from './api.ts';
import { classificationPublicationAttempts } from './classification-publication.ts';

const at = '2026-10-19T00:00:00.000Z';
const command: CatalogClassificationAssignmentRequest = {
  kind: 'assignment',
  taxonomyRevision: 1,
  family: 'toys',
  operation: 'replace',
  subcategoryIds: [],
  products: [
    { productId: 'p1', expectedUpdatedAt: at },
    { productId: 'p2', expectedUpdatedAt: at },
  ],
  includeSavedRevision: true,
};
const saved: CatalogClassificationAssignmentResult = {
  kind: 'assignment',
  results: command.products.map(({ productId }) => ({
    productId,
    status: 'saved',
    updatedAt: '2026-10-19T01:00:00.000Z',
  })),
};
test('classification publication freezes saved revisions and never maps classification into product values', () => {
  const attempts = classificationPublicationAttempts(command, saved);
  assert.equal(attempts.length, 2);
  for (const [index, attempt] of attempts.entries()) {
    assert.equal(attempt.productId, command.products[index]?.productId);
    assert.equal(attempt.expectedUpdatedAt, '2026-10-19T01:00:00.000Z');
    assert.deepEqual(attempt.values, {});
    assert.equal(Object.isFrozen(attempt), true);
  }
  assert.notEqual(attempts[0]?.operationId, attempts[1]?.operationId);
});
test('classification publication refuses partial duplicate extra unknown and unversioned receipts before generating attempts', () => {
  const first = saved.results[0];
  const firstProduct = command.products[0];
  assert.ok(first && firstProduct);
  for (const result of [
    { ...saved, refreshRequired: true },
    { ...saved, results: saved.results.slice(0, 1) },
    { ...saved, results: [first, first] },
    {
      ...saved,
      results: [...saved.results, { productId: 'other', status: 'saved' as const, updatedAt: at }],
    },
    { ...saved, results: [first, { productId: 'p2', status: 'unknown' as const }] },
    { ...saved, results: [first, { productId: 'p2', status: 'saved' as const }] },
    {
      ...saved,
      results: [first, { productId: 'p2', status: 'saved' as const, updatedAt: 'bad' }],
    },
  ])
    assert.throws(() => classificationPublicationAttempts(command, result));
  assert.throws(() =>
    classificationPublicationAttempts({ ...command, includeSavedRevision: false }, saved),
  );
  assert.throws(() =>
    classificationPublicationAttempts(
      { ...command, products: [firstProduct, firstProduct] },
      saved,
    ),
  );
});

test('classification BUSY retries check original identity before every send', async (t) => {
  let original = true;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    original = false;
    return Response.json(
      { ok: false, error: { code: 'BUSY', message: 'Nothing saved' } },
      { status: 409 },
    );
  });
  await assert.rejects(
    assignmentCall(command, undefined, undefined, () => {
      if (!original) throw new AdminApiError('UNAUTHORIZED', 'Changed account');
    }),
    (error) => error instanceof AdminApiError && error.code === 'UNAUTHORIZED',
  );
  assert.equal(calls, 1);
});
test('a changed account after classification response cannot accept the old receipt', async (t) => {
  let original = true;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    original = false;
    return Response.json({ ok: true, data: saved });
  });
  await assert.rejects(
    assignmentCall(command, undefined, undefined, () => {
      if (!original) throw new AdminApiError('UNAUTHORIZED', 'Changed account');
    }),
    (error) => error instanceof AdminApiError && error.code === 'UNAUTHORIZED',
  );
  assert.equal(calls, 1);
});

test('owned classification recovery cannot infer this publication from unrelated published product rows', () => {
  const before = command.products.map(({ productId }) => ({
    _id: productId,
    productFamily: 'toys',
    subcategoryIds: [],
    published: false,
  }));
  const snapshot = {
    ...unresolvedClassificationSnapshot(command, saved.results, {
      updated: 0,
      items: [],
      failures: command.products.map(({ productId }) => ({
        id: productId,
        code: 'OPERATION_UNCONFIRMED',
        message: 'Unknown original',
        outcome: 'unconfirmed' as const,
      })),
    }),
    ownedPublication: true as const,
  };
  assert.equal(
    matchesVerifiedOutcome(
      snapshot,
      before,
      before.map((product) => ({ ...product, published: true })),
    ),
    false,
  );
});

test('publication capability rejects missing extra and nonboolean responses without assuming availability', async (t) => {
  for (const data of [null, {}, { enabled: 'true' }, { enabled: true, other: true }]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ ok: true, data }),
    );
    await assert.rejects(
      fetchCatalogDetailCapabilities(),
      (error) => error instanceof AdminApiError && error.code === 'INVALID_RESPONSE',
    );
    mocked.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true, data: { enabled: false } }),
  );
  assert.deepEqual(await fetchCatalogDetailCapabilities(), { enabled: false });
});
