import assert from 'node:assert/strict';
import test from 'node:test';
import type { BatchUpdateResult } from './api.ts';
import { mergeTablePublication } from './catalog-table-publication.ts';
const owner = { actorId: 'original', endpoint: 'https://table.test/api/admin' };
const a = {
  scope: {
    productId: 'p',
    operationId: '12345678-1234-4234-8234-123456789012',
    inputDigest: 'a'.repeat(64),
  },
};
const b = { scope: { ...a.scope, operationId: '12345678-1234-4234-8234-123456789099' } };
function pending(): BatchUpdateResult {
  return {
    updated: 0,
    items: [],
    failures: [{ id: 'p', code: 'UNAVAILABLE', message: 'Check original', outcome: 'unconfirmed' }],
    publication: { owner, checkpoints: [a] },
  };
}
function confirmed(): BatchUpdateResult {
  return {
    updated: 1,
    items: [{ _id: 'p', name: 'Own confirmed product' }],
    failures: [],
    publication: { owner, checkpoints: [] },
  };
}
test('a result for the same product under a different original task is not adopted', () => {
  const original = pending();
  assert.equal(mergeTablePublication(original, confirmed(), [b]), original);
});
test('an original task result under a different actor or endpoint is not adopted', () => {
  for (const changed of [
    { ...owner, actorId: 'other' },
    { ...owner, endpoint: 'https://other.test/api/admin' },
  ]) {
    const original = pending();
    const next = confirmed();
    assert.ok(next.publication);
    next.publication.owner = changed;
    assert.equal(mergeTablePublication(original, next, [a]), original);
  }
});
test('an owned confirmation replaces only its unresolved result and keeps unchanged rows', () => {
  const original = pending();
  original.unchanged = [{ _id: 'already-live' }];
  const result = mergeTablePublication(original, confirmed(), [a]);
  assert.equal(result.updated, 1);
  assert.equal(result.unchanged?.length, 1);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.publication?.checkpoints, []);
  assert.equal(
    mergeTablePublication(result, confirmed(), [a]),
    result,
    'a repeated response cannot increase the count',
  );
});
test('stopping another original task does not undo a confirmed publication of the product', () => {
  const original = confirmed();
  assert.ok(original.publication);
  original.publication.checkpoints = [b];
  const stopped: BatchUpdateResult = {
    updated: 0,
    items: [],
    failures: [
      {
        id: 'p',
        code: 'OPERATION_CANCELLED',
        message: 'Original task stopped',
        outcome: 'rejected',
      },
    ],
    publication: { owner, checkpoints: [] },
  };
  const result = mergeTablePublication(original, stopped, [b]);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.publication?.checkpoints, []);
});

test('a matching operation ID with a different bound digest cannot replace an original result', () => {
  const original = pending();
  const altered = { scope: { ...a.scope, inputDigest: 'b'.repeat(64) } };
  assert.equal(mergeTablePublication(original, confirmed(), [altered]), original);
});
