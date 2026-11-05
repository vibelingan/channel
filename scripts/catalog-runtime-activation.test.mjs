import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertInitialCatalogRuntime,
  settleInitialCatalogRuntime,
} from './release/catalog-runtime-activation.mjs';
function setup() {
  let clock = 1000;
  let row = null;
  const sleeps = [];
  let writes = 0;
  const state = { configurationHash: 'b'.repeat(64), maximumTimeoutSeconds: 900 };
  return {
    siteOrigin: 'https://fixture.example',
    codeSha: 'a'.repeat(40),
    sourceRunId: '123',
    state,
    read: async () => structuredClone(state),
    now: () => clock,
    wait: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    sleeps,
    registry: {
      get: async () => structuredClone(row),
      set: async (r) => {
        writes++;
        row = structuredClone(r);
      },
    },
    row: () => row,
    writes: () => writes,
  };
}
test('first activation waits the full configured writer duration plus rollout/transaction allowance', async () => {
  const x = setup();
  const r = await settleInitialCatalogRuntime(x);
  assert.equal(
    x.sleeps.reduce((a, b) => a + b, 0),
    1020000,
  );
  assert.equal(r.accepted, true);
  assert.equal(x.writes(), 2);
  assertInitialCatalogRuntime(r, x.siteOrigin, x.now());
});
test('an interrupted wait resumes the saved deadline, without another full interval', async () => {
  const x = setup();
  let once = true;
  const wait = x.wait;
  x.wait = async (ms) => {
    await wait(ms);
    if (once) {
      once = false;
      throw Error('interrupted');
    }
  };
  await assert.rejects(settleInitialCatalogRuntime(x));
  assert.equal(x.row().accepted, false);
  await settleInitialCatalogRuntime(x);
  assert.equal(
    x.sleeps.reduce((a, b) => a + b, 0),
    1020000,
  );
});
test('an accepted replay does not sleep or write again', async () => {
  const x = setup();
  await settleInitialCatalogRuntime(x);
  const count = x.sleeps.length;
  await settleInitialCatalogRuntime(x);
  assert.equal(x.sleeps.length, count);
  assert.equal(x.writes(), 2);
});
test('configuration drift during the window cannot produce an accepted proof', async () => {
  const x = setup();
  let reads = 0;
  x.read = async () => ({ ...x.state, configurationHash: (reads++ ? 'c' : 'b').repeat(64) });
  await assert.rejects(settleInitialCatalogRuntime(x));
  assert.equal(x.row().accepted, false);
});
test('a lost state acknowledgement is settled by readback once', async () => {
  const x = setup();
  const save = x.registry.set;
  x.registry.set = async (row) => {
    await save(row);
    throw Error('lost reply');
  };
  await settleInitialCatalogRuntime(x);
  assert.equal(x.writes(), 2);
});
test('pending, premature, foreign and malformed proofs block tracked HTML', async () => {
  const x = setup();
  const row = await settleInitialCatalogRuntime(x);
  for (const patch of [
    { accepted: false },
    { acceptedAt: row.usableAfter - 1 },
    { siteOrigin: 'https://other.example' },
    { usableAfter: 0 },
    { maximumTimeoutSeconds: 9000 },
  ])
    assert.throws(() => assertInitialCatalogRuntime({ ...row, ...patch }, x.siteOrigin, x.now()));
});
