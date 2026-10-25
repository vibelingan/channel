import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import {
  clock,
  composition,
  plan,
  policy,
  receipt,
  runner,
  stepInput,
} from './release-state-fixtures.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';

const key = 'a'.repeat(64);
test('installed SDK writes the control document and returns it through a later transaction', async (t) => {
  const f = cloudbaseFixture(t);
  await f.store.transact(async (tx) => {
    assert.equal(await tx.get('targets', key), null);
    tx.put('targets', key, { version: 1 });
  });
  const value = await f.store.transact((tx) => tx.get('targets', key));
  assert.deepEqual(value, { version: 1 });
  assert.equal(f.rows.size, 1);
});

test('a CloudBase error response is never mistaken for an absent record', async (t) => {
  const f = cloudbaseFixture(t);
  f.fault.get({ code: 'DATABASE_PERMISSION_DENIED', message: 'denied' });
  await assert.rejects(
    f.store.transact((tx) => tx.get('targets', key)),
    /DATABASE_PERMISSION_DENIED/,
  );
});

for (const result of [
  { code: 'DATABASE_PERMISSION_DENIED' },
  { data: { updated: 0 }, requestId: 'write' },
  { data: { updated: 1 } },
]) {
  test(`unconfirmed SDK write rolls back every staged document: ${JSON.stringify(result)}`, async (t) => {
    const f = cloudbaseFixture(t);
    f.fault.set(result);
    await assert.rejects(
      f.store.transact(async (tx) => {
        await tx.get('targets', key);
        tx.put('targets', key, { version: 1 });
      }),
      { code: 'STORE_WRITE_FAILED' },
    );
    assert.equal(f.rows.size, 0);
  });
}

test('all reads precede writes and the adapter refuses blind or unbounded writes', async (t) => {
  const f = cloudbaseFixture(t);
  await assert.rejects(
    f.store.transact(async (tx) => {
      await tx.get('targets', key);
      tx.put('targets', key, { version: 1 });
      await tx.get('targets', key);
    }),
    { code: 'READ_AFTER_WRITE' },
  );
  await assert.rejects(
    f.store.transact((tx) => tx.put('targets', key, { version: 1 })),
    { code: 'BLIND_WRITE' },
  );
  await assert.rejects(
    f.store.transact(async (tx) => {
      await tx.get('targets', key);
      tx.put('targets', key, { description: 'x'.repeat(129 * 1024) });
    }),
    { code: 'LEDGER_SIZE_LIMIT' },
  );
  assert.equal(f.rows.size, 0);
});

test('SDK environment and physical collections remain confined to the release control plane', async (t) => {
  const f = cloudbaseFixture(t);
  assert.throws(() => createCloudbaseReleaseStore({ db: f.db, envId: 'wrong-env' }), {
    code: 'STORE_ENV_MISMATCH',
  });
  await assert.rejects(
    f.store.transact((tx) => tx.get('products', key)),
    { code: 'INVALID_LEDGER_REF' },
  );
  assert.equal(
    f.calls.some((call) => call.params.collectionName === 'products'),
    false,
  );
});

test('installed SDK conflict retry does not increment a newly acquired fence twice', async (t) => {
  const f = cloudbaseFixture(t);
  f.fault.commit('conflict');
  const client = createReleaseCoordinator({ store: f.store, policy, clock: clock().now });
  const guard = await client.acquire(runner('r1'));
  assert.equal(guard.fence, 1);
  assert.equal((await client.status()).target.nextFence, 1);
});

test('SDK lost commit acknowledgement is resolved by durable read-back without a new activation', async (t) => {
  const f = cloudbaseFixture(t);
  const client = createReleaseCoordinator({ store: f.store, policy, clock: clock().now });
  const guard = await client.acquire(runner('r1'));
  await client.startRun({
    guard,
    runId: 'adopt-A',
    kind: 'adopt',
    scopeKey: 'site',
    composition: composition(),
    plan: plan(1),
  });
  const step = await client.beginStep({ guard, runId: 'adopt-A', ...stepInput('accept') });
  await client.confirmStep({
    guard,
    runId: 'adopt-A',
    stepId: step.stepId,
    receipt: receipt(step),
  });
  f.fault.commit('lost-ack');
  await assert.rejects(
    client.commitRun({ guard, runId: 'adopt-A', changeSetRef: 'changes:A' }),
    /Commit response lost/,
  );
  const restarted = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db: f.db, envId: policy.envId }),
    policy,
    clock: clock().now,
  });
  const actual = await restarted.status();
  const replay = await restarted.commitRun({ guard, runId: 'adopt-A', changeSetRef: 'changes:A' });
  assert.equal(replay.status, 'already-committed');
  assert.equal(replay.activation.activationId, actual.scope.active.activationId);
  assert.equal((await restarted.status()).scope.version, 1);
});

test('the isolated live drill uses separate fixed collections through the same real transaction adapter', async (t) => {
  const f = cloudbaseFixture(t);
  const drill = createCloudbaseReleaseStore({ db: f.db, envId: 'fixture-env', profile: 'drill' });
  await drill.transact(async (tx) => {
    await tx.get('targets', key);
    tx.put('targets', key, { version: 1 });
  });
  assert(
    f.calls
      .filter((c) => c.params.collectionName)
      .every((c) => c.params.collectionName === 'seoReleaseDrillTargets'),
  );
  assert.equal(await f.store.transact((tx) => tx.get('targets', key)), null);
  assert.throws(
    () => createCloudbaseReleaseStore({ db: f.db, envId: 'fixture-env', profile: 'products' }),
    /STORE_PROFILE/,
  );
});
