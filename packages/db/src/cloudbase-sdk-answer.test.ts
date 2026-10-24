import assert from 'node:assert/strict';
import test from 'node:test';
import { persistStagedApprovalInCloud } from './catalog-detail-staging.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';
import { assertDocumentWrite, sdkAnswer } from './cloudbase-sdk-answer.ts';

const conflict = { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'write conflict' };

test('a coded SDK answer is rethrown with its code; a normal answer passes through', () => {
  assert.throws(
    () => sdkAnswer(conflict),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'write conflict' &&
      Reflect.get(error, 'code') === 'DATABASE_TRANSACTION_CONFLICT',
  );
  const ok = { updated: 1, requestId: 'r' };
  assert.equal(sdkAnswer(ok), ok);
  assert.equal(sdkAnswer(null), null);
  assert.deepEqual(sdkAnswer({ code: '', data: 1 }), { code: '', data: 1 });
});

test('the approval transaction surfaces a conflict answered on a read, not "missing" (DEC-21)', async () => {
  // In a transaction the installed SDK answers a failed read with { code },
  // without throwing; read as "no document" it would look like a missing photo.
  const doc = { get: async () => conflict, set: async () => conflict };
  const db = {
    runTransaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ collection: () => ({ doc: () => doc }) }),
  } as unknown as NodeSdkDatabase;
  await assert.rejects(
    persistStagedApprovalInCloud(db, 'admin', { action: 'finish', jobId: 'a'.repeat(64) }),
    (error: unknown) => Reflect.get(error as object, 'code') === 'DATABASE_TRANSACTION_CONFLICT',
  );
});

const validWrites: Array<{ operation: 'set' | 'update' | 'remove'; response: unknown }> = [
  { operation: 'update', response: { updated: 1 } },
  { operation: 'remove', response: { deleted: 1 } },
  { operation: 'set', response: { updated: 0, upserted: [{ _id: 'p' }] } },
  { operation: 'set', response: { updated: 1, upserted: [{ _id: undefined }] } },
];
for (const [index, value] of validWrites.entries())
  test(`single-document ${value.operation} accepts installed-SDK acknowledgement ${index}`, () => {
    assert.doesNotThrow(() => assertDocumentWrite(value.response, 'p', value.operation));
  });
for (const operation of ['set', 'update', 'remove'] as const)
  for (const [index, response] of [
    undefined,
    null,
    [],
    {},
    { updated: 0, deleted: 0 },
    { updated: '1', deleted: '1' },
    { updated: 2, deleted: 2 },
    { updated: Number.NaN, deleted: -1 },
  ].entries())
    test(`single-document ${operation} refuses missing or invalid count ${index}`, () => {
      assert.throws(() => assertDocumentWrite(response, 'p', operation), /not acknowledged/);
    });
for (const response of [
  { updated: 0, upserted: [{ _id: 'other' }] },
  { updated: 0, upserted: [{ _id: 'p' }, { _id: 'other' }] },
  { updated: 0, upserted: [] },
])
  test(`single-document set refuses wrong or ambiguous upsert identity ${JSON.stringify(response)}`, () => {
    assert.throws(() => assertDocumentWrite(response, 'p', 'set'), /not acknowledged/);
  });
test('single-document update cannot masquerade as a create acknowledgement', () => {
  assert.throws(
    () => assertDocumentWrite({ updated: 0, upserted: [{ _id: 'p' }] }, 'p', 'update'),
    /not acknowledged/,
  );
});
for (const operation of ['set', 'update', 'remove'] as const)
  test(`single-document ${operation} preserves a coded failure even alongside a success count`, () => {
    assert.throws(
      () =>
        assertDocumentWrite(
          { ...conflict, updated: 1, deleted: 1, upserted: [{ _id: 'p' }] },
          'p',
          operation,
        ),
      (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === conflict.code,
    );
  });
