import assert from 'node:assert/strict';
import test from 'node:test';
import { persistStagedApprovalInCloud } from './catalog-detail-staging.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';
import { sdkAnswer } from './cloudbase-sdk-answer.ts';

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
