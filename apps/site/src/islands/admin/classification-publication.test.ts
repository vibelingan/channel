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
import {
  classificationPublicationAttempts,
  classificationPublicationFeedback,
  keepClassificationCommand,
  keptClassificationPublicationAttempts,
  matchesKeptClassification,
} from './classification-publication.ts';

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

test('keeping classification captures reviewed versions without assignment results or product field values', () => {
  const products = [
    { _id: 'p1', updatedAt: at, productFamily: 'misc', published: false },
    {
      _id: 'p2',
      updatedAt: at,
      productFamily: 'headphones',
      category: 'wired',
      subcategoryIds: ['headphones-wired'],
      published: false,
    },
  ];
  const kept = keepClassificationCommand(products);
  products[0].updatedAt = '2026-10-19T02:00:00.000Z';
  const attempts = keptClassificationPublicationAttempts(kept);
  assert.equal(kept.kind, 'keep');
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    assert.equal(attempt.expectedUpdatedAt, at);
    assert.deepEqual(attempt.values, {});
    assert.ok(Object.isFrozen(attempt));
  }
  assert.notEqual(attempts[0]?.operationId, attempts[1]?.operationId);
});

test('keeping classification refuses empty duplicate oversized and unversioned selections before creating an attempt', () => {
  const first = { _id: 'p1', updatedAt: at };
  for (const products of [
    [],
    [first, first],
    Array.from({ length: 21 }, (_, i) => ({ ...first, _id: `p${i}` })),
    [{ _id: 'p1' }],
    [{ ...first, updatedAt: 'invalid' }],
  ])
    assert.throws(
      () => keepClassificationCommand(products),
      (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
    );
  assert.throws(() =>
    keptClassificationPublicationAttempts({
      kind: 'assignment',
      products: [{ productId: 'p1', expectedUpdatedAt: at }],
      includeSavedRevision: true,
    }),
  );
});

test('kept-classification recovery needs owned confirmation and preserves field presence and mixed classifications', () => {
  const products = [
    { _id: 'p1', updatedAt: at, productFamily: 'misc', published: false },
    {
      _id: 'p2',
      updatedAt: at,
      productFamily: 'headphones',
      category: 'wired',
      subcategoryIds: ['headphones-wired'],
      published: false,
    },
  ];
  const kept = keepClassificationCommand(products);
  const unknown = unresolvedClassificationSnapshot(kept, null, null);
  assert.deepEqual(unknown.unresolvedIds, ['p1', 'p2']);
  assert.deepEqual(unknown.attentionIds, []);
  assert.equal(unknown.ownedPublication, true);
  const published = products.map((product) => ({ ...product, published: true }));
  assert.equal(matchesVerifiedOutcome(unknown, products, published), false);
  const confirmed = unresolvedClassificationSnapshot(kept, null, {
    updated: 2,
    items: published,
    failures: [],
  });
  assert.equal(matchesVerifiedOutcome(confirmed, products, published), true);
  assert.equal(
    matchesVerifiedOutcome(confirmed, products, [
      { ...published[0], subcategoryIds: [], _id: 'p1' },
      published[1],
    ]),
    false,
  );
  assert.equal(
    matchesKeptClassification(products[0], { ...products[0], category: undefined }),
    false,
  );
  assert.equal(
    matchesKeptClassification(products[1], { ...products[1], productFamily: 'toys' }),
    false,
  );
});

test('kept-classification recovery distinguishes rejected missing classification from unknown siblings without saved receipts', () => {
  const kept = keepClassificationCommand(['p1', 'p2', 'p3'].map((_id) => ({ _id, updatedAt: at })));
  const snapshot = unresolvedClassificationSnapshot(kept, null, {
    updated: 1,
    items: [{ _id: 'p1' }],
    failures: [
      {
        id: 'p2',
        code: 'VALIDATION_ERROR',
        message: 'Choose a website category before publishing.',
        outcome: 'rejected',
      },
      {
        id: 'p3',
        code: 'UNAVAILABLE',
        message: 'Check original publication',
        outcome: 'unconfirmed',
      },
    ],
  });
  assert.deepEqual(snapshot.confirmedPublishedIds, ['p1']);
  assert.deepEqual(snapshot.attentionIds, ['p2']);
  assert.deepEqual(snapshot.unresolvedIds, ['p3']);
  assert.equal(snapshot.issuesById.p2, 'Choose a website category before publishing.');
});

test('a stopped request that never reserved its old version is neither published nor retryable', () => {
  const result = classificationPublicationFeedback([
    {
      state: 'not-started',
      scope: { productId: 'changed', operationId: '12345678-1234-4234-8234-123456789012' },
      stoppedBeforeStart: true,
    },
  ]);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.failures[0]?.code, 'OPERATION_SUPERSEDED');
  assert.equal(result.failures[0]?.outcome, 'rejected');
  assert.equal(result.failures[0]?.retryable, false);
  assert.match(result.failures[0]?.message ?? '', /changed before this publication started/);
});
