import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import { createDummyDatabaseHandler } from './release-drill/handler.mjs';
const token = 'f'.repeat(64);
const envId = 'diversity-123-d9grnqfux221323bb';
function setup(t) {
  const f = cloudbaseFixture(t);
  // The SDK transport fixture uses a synthetic environment; only the bound configuration differs.
  f.db.config.env = envId;
  const options = {
    db: f.db,
    envId,
    runId: '123',
    codeSha: 'a'.repeat(40),
    tokenDigest: createHash('sha256').update(token).digest('hex'),
  };
  const a = createDummyDatabaseHandler({ ...options, version: 'A' });
  const b = createDummyDatabaseHandler({ ...options, version: 'B' });
  const call = (fn, event) => fn({ token, ...event });
  return { ...f, options, a, b, call };
}
test('real SDK transaction path preserves B fields, new records and tombstones after returning to A', async (t) => {
  const f = setup(t);
  const id = 'seo-drill-123-one';
  await f.call(f.a, { action: 'create', id, requestId: 'create-one', label: 'A' });
  await f.call(f.b, {
    action: 'update',
    id,
    requestId: 'update-one',
    expectedRevision: 1,
    patch: { label: 'B', note: 'new optional field' },
  });
  await f.call(f.b, {
    action: 'create',
    id: 'seo-drill-123-new',
    requestId: 'create-new',
    label: 'new B record',
    note: 'preserve',
  });
  await f.call(f.b, {
    action: 'create',
    id: 'seo-drill-123-deleted',
    requestId: 'create-deleted',
    label: 'tombstone',
  });
  await f.call(f.b, {
    action: 'delete',
    id: 'seo-drill-123-deleted',
    requestId: 'delete-one',
    expectedRevision: 1,
  });
  const result = await f.call(f.a, {
    action: 'update',
    id,
    requestId: 'after-restore',
    expectedRevision: 2,
    patch: { label: 'A restored' },
  });
  assert.equal(result.record.note, 'new optional field');
  assert.equal(
    (await f.call(f.a, { action: 'read', id: 'seo-drill-123-new' })).record.note,
    'preserve',
  );
  assert.equal(
    (await f.call(f.a, { action: 'read', id: 'seo-drill-123-deleted' })).record.deleted,
    true,
  );
  assert(
    f.calls
      .filter((c) => c.params.collectionName)
      .every((c) => c.params.collectionName === 'seoReleaseDrillFixtures'),
  );
});
test('no authentication, foreign IDs, caller collections and stale revisions cannot write', async (t) => {
  const f = setup(t);
  const id = 'seo-drill-123-one';
  await assert.rejects(f.a({ action: 'health', token: 'a'.repeat(64) }), /authentication/);
  await assert.rejects(
    f.call(f.a, {
      action: 'create',
      id: 'seo-drill-124-one',
      requestId: 'other',
      label: 'wrong run',
    }),
    /this drill/,
  );
  await assert.rejects(f.call(f.a, { action: 'health', collection: 'products' }), /Unsupported/);
  assert.equal(f.calls.length, 0);
  await f.call(f.a, { action: 'create', id, requestId: 'create-one', label: 'A' });
  await assert.rejects(
    f.call(f.a, {
      action: 'update',
      id,
      requestId: 'stale',
      expectedRevision: 4,
      patch: { label: 'overwrite' },
    }),
    /revision conflict/,
  );
  assert.equal((await f.call(f.a, { action: 'read', id })).record.label, 'A');
});
test('lost commit response can be resolved with the exact same request without a duplicate mutation', async (t) => {
  const f = setup(t);
  const event = { action: 'create', id: 'seo-drill-123-one', requestId: 'lost', label: 'A' };
  f.fault.commit('lost-ack');
  await assert.rejects(f.call(f.a, event), /Commit response lost/);
  const result = await f.call(f.a, event);
  assert.equal(result.replayed, true);
  assert.equal(result.record.revision, 1);
  await assert.rejects(f.call(f.a, { ...event, label: 'different' }), /request conflict/);
  assert.equal(f.rows.size, 1);
});
test('an unconfirmed database write cannot return success', async (t) => {
  const f = setup(t);
  f.fault.set({ data: { updated: 0 }, requestId: 'zero' });
  await assert.rejects(
    f.call(f.a, { action: 'create', id: 'seo-drill-123-one', requestId: 'create', label: 'A' }),
    /not confirmed/,
  );
  assert.equal(f.rows.size, 0);
});
