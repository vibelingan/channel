import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dummyRecoveryScope, loadDummyFunction } from '../release/dummy-recovery-fixture.mjs';

const path = process.env.RELEASE_COMPATIBILITY_CONTEXT;
assert(path, 'Use the fixed compatibility runner to supply an archived dummy package');
const { context, baselinePackagePath } = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(context.name, dummyRecoveryScope.functionName);
const archived = loadDummyFunction(readFileSync(baselinePackagePath));
test.after(archived.close);
const row = {
  _id: 'seo-drill-compatibility',
  purpose: dummyRecoveryScope.purpose,
  label: 'current data',
  revision: 2,
  deleted: false,
};

test('dummy A reads both data formats', async () => {
  for (const record of [row, { ...row, note: 'new optional field' }]) {
    const result = await archived.main({ action: 'read', id: row._id, record });
    assert.deepEqual(result.record, record);
  }
});

test('dummy A preserves newer fields and deleted records', async () => {
  const record = { ...row, note: 'keep this', future: { nested: ['keep', 42] } };
  const updated = await archived.main({
    action: 'update',
    id: row._id,
    record,
    patch: { label: 'edited by A' },
  });
  assert.equal(updated.record.label, 'edited by A');
  assert.equal(updated.record.note, record.note);
  assert.deepEqual(updated.record.future, record.future);
  assert.equal(updated.record.revision, record.revision + 1);
  await assert.rejects(
    archived.main({
      action: 'update',
      id: row._id,
      record: { ...record, deleted: true },
      patch: { label: 'revive' },
    }),
  );
});

test('dummy A serves both client contracts', async () => {
  const result = await archived.main({
    action: 'read',
    id: row._id,
    record: { ...row, note: 'optional in client v2' },
  });
  assert.equal(typeof result.record.label, 'string');
  assert.equal(result.record.note, 'optional in client v2');
  const olderData = await archived.main({ action: 'read', id: row._id, record: row });
  assert.equal(olderData.record.note ?? null, null);
});

test('dummy A exposes its actual archived identity', async () => {
  const health = await archived.main({ action: 'health' });
  assert.equal(health.purpose, dummyRecoveryScope.purpose);
  assert.equal(health.version, 'A');
  assert.equal(health.codeSha, context.baseline.codeSha);
});
