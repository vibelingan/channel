import assert from 'node:assert/strict';
import test from 'node:test';
import { assertInitialCatalogRuntime } from './release/catalog-runtime-activation.mjs';
import { settleCatalogRuntimeRecovery } from './release/catalog-runtime-recovery.mjs';
import { identity } from './release/input.mjs';

function setup() {
  let clock = 2_000_000;
  let row = {
    schemaVersion: 1,
    purpose: 'initial-catalog-runtime',
    siteOrigin: 'https://fixture.example',
    codeSha: 'a'.repeat(40),
    sourceRunId: '123',
    configurationHash: 'b'.repeat(64),
    maximumTimeoutSeconds: 900,
    observedAt: 1000,
    usableAfter: 1_021_000,
    accepted: true,
    acceptedAt: 1_021_000,
  };
  const previous = structuredClone(row);
  const history = new Map();
  const sleeps = [];
  const writes = [];
  let reads = 0;
  const state = {
    configurationHash: 'c'.repeat(64),
    maximumTimeoutSeconds: 900,
    writerVersions: [
      { name: 'admin', releaseId: 'd'.repeat(40) },
      { name: 'alibaba-catalog-sync', releaseId: 'e'.repeat(40) },
    ],
  };
  return {
    siteOrigin: previous.siteOrigin,
    executorSha: 'f'.repeat(40),
    sourceRunId: '456',
    previousActivationHash: identity(previous),
    previous,
    history,
    state,
    reads: () => reads,
    read: async () => {
      reads++;
      return structuredClone(state);
    },
    now: () => clock,
    wait: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    sleeps,
    writes,
    row: () => structuredClone(row),
    replaceRow: (value) => {
      row = structuredClone(value);
    },
    registry: {
      get: async () => structuredClone(row),
      set: async (value) => {
        writes.push(structuredClone(value));
        row = structuredClone(value);
      },
      getHistory: async (hash) => structuredClone(history.get(hash) ?? null),
      putHistory: async (hash, value) => {
        if (history.has(hash)) throw Error('history already exists');
        history.set(hash, structuredClone(value));
      },
    },
  };
}

test('recovery preserves the exact old proof and waits for newly enabled writers', async () => {
  const x = setup();
  const result = await settleCatalogRuntimeRecovery(x);
  assert.deepEqual(x.history.get(x.previousActivationHash), x.previous);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.purpose, 'catalog-writer-recovery');
  assert.equal(result.executorSha, x.executorSha);
  assert.deepEqual(result.writerVersions, x.state.writerVersions);
  assert.equal(result.previousActivationHash, x.previousActivationHash);
  assert.equal(result.sourceRunId, '456');
  assert.equal(result.observedAt, 2_000_000);
  assert.equal(result.usableAfter, 3_020_000);
  assert.equal(result.acceptedAt, result.usableAfter);
  assert.equal(
    x.sleeps.reduce((a, b) => a + b, 0),
    1_020_000,
  );
  assert.equal(x.reads(), 2);
  assert.equal(x.writes.length, 2);
  assertInitialCatalogRuntime(result, x.siteOrigin, x.now());
  assertInitialCatalogRuntime(x.previous, x.siteOrigin, x.now());
});

test('SDK document identifiers are normalized only at the public assertion boundary', async () => {
  const x = setup();
  const recovered = await settleCatalogRuntimeRecovery(x);
  for (const proof of [x.previous, recovered]) {
    const sdkDocument = { ...proof, _id: 'runtime-activation' };
    assert.deepEqual(assertInitialCatalogRuntime(sdkDocument, x.siteOrigin, x.now()), proof);
    assert.equal(sdkDocument._id, 'runtime-activation');
    for (const id of ['another-activation', null, undefined, 42])
      assert.throws(() =>
        assertInitialCatalogRuntime({ ...proof, _id: id }, x.siteOrigin, x.now()),
      );
  }
  assert.throws(() =>
    assertInitialCatalogRuntime(
      { ...recovered, _id: 'runtime-activation', unexpected: true },
      x.siteOrigin,
      x.now(),
    ),
  );
});

test('internal recovery records must already omit SDK document identifiers', async () => {
  const x = setup();
  x.replaceRow({ ...x.previous, _id: 'runtime-activation' });
  x.previousActivationHash = identity(x.row());
  await assert.rejects(settleCatalogRuntimeRecovery(x), /normalized|document identifier/i);
  assert.equal(x.history.size, 0);
  assert.equal(x.writes.length, 0);
});

test('a new dispatch resumes one pending proof without resetting its deadline or provenance', async () => {
  const x = setup();
  const wait = x.wait;
  let interrupted = true;
  x.wait = async (ms) => {
    await wait(ms);
    if (interrupted) {
      interrupted = false;
      throw Error('runner stopped');
    }
  };
  await assert.rejects(settleCatalogRuntimeRecovery(x), /runner stopped/);
  const pending = x.row();
  assert.equal(pending.accepted, false);
  x.sourceRunId = '789';
  const result = await settleCatalogRuntimeRecovery(x);
  assert.equal(result.sourceRunId, '456');
  assert.equal(result.observedAt, pending.observedAt);
  assert.equal(result.usableAfter, pending.usableAfter);
  assert.equal(
    x.sleeps.reduce((a, b) => a + b, 0),
    1_020_000,
  );
  assert.equal(x.history.size, 1);
  assert.equal(x.writes.length, 2);
});

test('an accepted replay reads current state but neither sleeps nor writes', async () => {
  const x = setup();
  const result = await settleCatalogRuntimeRecovery(x);
  const waits = x.sleeps.length;
  const writes = x.writes.length;
  x.sourceRunId = '789';
  assert.deepEqual(await settleCatalogRuntimeRecovery(x), result);
  assert.equal(x.sleeps.length, waits);
  assert.equal(x.writes.length, writes);
});

test('another recovery requires explicitly selecting the last accepted proof and preserves its history', async () => {
  const x = setup();
  const first = await settleCatalogRuntimeRecovery(x);
  x.state.configurationHash = '1'.repeat(64);
  await assert.rejects(settleCatalogRuntimeRecovery(x), /differs/i);
  assert.equal(x.writes.length, 2);
  x.previousActivationHash = identity(first);
  x.sourceRunId = '789';
  const second = await settleCatalogRuntimeRecovery(x);
  assert.equal(second.sourceRunId, '789');
  assert.equal(second.previousActivationHash, identity(first));
  assert.equal(second.observedAt, first.acceptedAt);
  assert.deepEqual(x.history.get(identity(first)), first);
  assert.equal(x.history.size, 2);
  assert.equal(
    x.sleeps.reduce((a, b) => a + b, 0),
    2_040_000,
  );
});

test('lost acknowledgements for history and proof writes are settled by exact readback', async () => {
  const x = setup();
  const put = x.registry.putHistory;
  const set = x.registry.set;
  x.registry.putHistory = async (...args) => {
    await put(...args);
    throw Error('lost history reply');
  };
  x.registry.set = async (...args) => {
    await set(...args);
    throw Error('lost proof reply');
  };
  await settleCatalogRuntimeRecovery(x);
  assert.equal(x.history.size, 1);
  assert.equal(x.writes.length, 2);
});

test('an unconfirmed history write never replaces the old activation', async () => {
  const x = setup();
  x.registry.putHistory = async () => {
    throw Error('not stored');
  };
  await assert.rejects(settleCatalogRuntimeRecovery(x), /history.*readback/i);
  assert.deepEqual(x.row(), x.previous);
  assert.equal(x.writes.length, 0);
});

test('an unconfirmed pending proof write is not retried or mistaken for a completed activation', async () => {
  const x = setup();
  let writes = 0;
  x.registry.set = async () => {
    writes++;
    throw Error('not stored');
  };
  await assert.rejects(settleCatalogRuntimeRecovery(x), /state needs exact readback/i);
  assert.equal(writes, 1);
  assert.deepEqual(x.row(), x.previous);
  assert.equal(x.sleeps.length, 0);
});

test('a conflicting immutable history record is never overwritten', async () => {
  const x = setup();
  x.history.set(x.previousActivationHash, { ...x.previous, sourceRunId: '999' });
  await assert.rejects(settleCatalogRuntimeRecovery(x), /history/i);
  assert.equal(x.writes.length, 0);
  assert.equal(x.history.get(x.previousActivationHash).sourceRunId, '999');
});

test('a stale expected prior proof cannot replace another accepted record', async () => {
  const x = setup();
  x.replaceRow({ ...x.previous, sourceRunId: '999' });
  await assert.rejects(settleCatalogRuntimeRecovery(x), /previous activation/i);
  assert.equal(x.history.size, 0);
  assert.equal(x.writes.length, 0);
});

test('configuration or actual writer changes during the wait leave the proof pending', async () => {
  for (const change of [
    (state) => {
      state.configurationHash = '1'.repeat(64);
    },
    (state) => {
      state.writerVersions[1].releaseId = '1'.repeat(40);
    },
  ]) {
    const x = setup();
    const read = x.read;
    x.read = async () => {
      if (x.reads() > 0) change(x.state);
      return read();
    };
    await assert.rejects(settleCatalogRuntimeRecovery(x), /changed during/i);
    assert.equal(x.row().accepted, false);
    assert.equal(x.writes.length, 1);
  }
});

test('a resumed proof rejects a different executor or current configuration', async () => {
  for (const change of [
    (x) => {
      x.executorSha = '1'.repeat(40);
    },
    (x) => {
      x.state.configurationHash = '1'.repeat(64);
    },
  ]) {
    const x = setup();
    x.wait = async () => {
      throw Error('runner stopped');
    };
    await assert.rejects(settleCatalogRuntimeRecovery(x));
    change(x);
    await assert.rejects(settleCatalogRuntimeRecovery(x), /differs/i);
    assert.equal(x.writes.length, 1);
  }
});

test('an external activation change during the wait is not overwritten', async () => {
  const x = setup();
  const read = x.read;
  x.read = async () => {
    const state = await read();
    if (x.reads() === 2) x.replaceRow({ ...x.row(), sourceRunId: '999' });
    return state;
  };
  await assert.rejects(settleCatalogRuntimeRecovery(x), /activation changed/i);
  assert.equal(x.row().sourceRunId, '999');
  assert.equal(x.writes.length, 1);
});

test('incomplete, foreign, premature and malformed recovery proofs cannot permit HTML builds', async () => {
  const x = setup();
  const row = await settleCatalogRuntimeRecovery(x);
  for (const patch of [
    { accepted: false },
    { acceptedAt: row.usableAfter - 1 },
    { observedAt: -1 },
    { siteOrigin: 'https://other.example' },
    { usableAfter: row.usableAfter - 1 },
    { maximumTimeoutSeconds: 901 },
    { executorSha: 'invalid' },
    { sourceRunId: '0' },
    { previousActivationHash: 'invalid' },
    { writerVersions: row.writerVersions.toReversed() },
    { writerVersions: [row.writerVersions[0]] },
    { writerVersions: [{ name: 'public-api', releaseId: 'a'.repeat(40) }, row.writerVersions[1]] },
    { unexpected: true },
  ])
    assert.throws(() => assertInitialCatalogRuntime({ ...row, ...patch }, x.siteOrigin, x.now()));
  assert.throws(() => assertInitialCatalogRuntime(row, x.siteOrigin, row.usableAfter - 1));
  assert.throws(() =>
    assertInitialCatalogRuntime(
      { ...row, siteOrigin: 'http://fixture.example' },
      'http://fixture.example',
      x.now(),
    ),
  );
});

test('invalid inputs and observations stop before any registry write', async () => {
  for (const change of [
    (x) => {
      x.previousActivationHash = undefined;
    },
    (x) => {
      x.siteOrigin = 'http://fixture.example';
    },
    (x) => {
      x.sourceRunId = '0';
    },
    (x) => {
      x.state.maximumTimeoutSeconds = 901;
    },
    (x) => {
      x.state.writerVersions = x.state.writerVersions.toReversed();
    },
    (x) => {
      x.state.writerVersions[0].releaseId = 'invalid';
    },
  ]) {
    const x = setup();
    change(x);
    await assert.rejects(settleCatalogRuntimeRecovery(x));
    assert.equal(x.writes.length, 0);
    assert.equal(x.history.size, 0);
  }
});

test('a clock that does not advance cannot manufacture a completed waiting window', async () => {
  const x = setup();
  x.wait = async () => {};
  await assert.rejects(settleCatalogRuntimeRecovery(x), /clock/i);
  assert.equal(x.row().accepted, false);
  assert.equal(x.writes.length, 1);
});
