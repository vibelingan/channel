import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import { composition, plan, receipt, stepInput } from './release-state-fixtures.mjs';
import { normalizePolicy } from './release/ledger.mjs';
import {
  createReleaseRegionalHandler,
  releaseRegionalInputHash,
} from './release/regional-coordinator.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';

const ownerRunId = 'site-41313740695-1';
const runnerRef = 'github:vibelingan/channel:41313740695:attempt-1';
const token = 'a'.repeat(64);
const codeSha = 'b'.repeat(40);
const config = {
  envId: policy.envId,
  targetId: normalizePolicy(policy).targetId,
  ownerRunId,
  runnerRef,
  codeSha,
  tokenDigest: createHash('sha256').update(token).digest('hex'),
};
function setup(t) {
  const f = cloudbaseFixture(t);
  f.db.config.env = policy.envId;
  const logs = [];
  let time = Date.parse('2026-11-01T00:00:00Z');
  const handler = createReleaseRegionalHandler(config, {
    createDatabase: () => f.db,
    now: () => time,
    onStatus: (row) => logs.push(row),
  });
  const request = (method, args = [], operationId = 'operation-1') => {
    const r = {
      schemaVersion: 1,
      token,
      ownerRunId,
      runnerRef,
      codeSha,
      targetId: config.targetId,
      operationId,
      method,
      args,
    };
    return { ...r, inputHash: releaseRegionalInputHash(r) };
  };
  return {
    ...f,
    logs,
    handler,
    request,
    advance: (ms) => {
      time += ms;
    },
  };
}

test('installed SDK commits the release lease and exact operation receipt atomically', async (t) => {
  const f = setup(t);
  const request = f.request('acquire', [{ ownerRunId, runnerRef }]);
  const first = await f.handler(request);
  assert.equal(first.ok, true);
  assert.equal(first.result.ownerRunId, ownerRunId);
  assert.equal(first.result.fence, 1);
  const replay = await f.handler(request);
  assert.deepEqual(replay.result, first.result);
  const status = await f.handler(f.request('status', [], 'status-1'));
  assert.equal(status.result.target.nextFence, 1);
  assert.equal(
    [...f.rows.keys()].filter((key) => key.startsWith('catalogSeoBuilders/release-op-')).length,
    1,
  );
  assert.equal(f.calls.filter((row) => row.action === 'database.startTransaction').length, 3);
});

test('expired receipt authority cannot return an old lease as current permission', async (t) => {
  const f = setup(t);
  const request = f.request('acquire', [{ ownerRunId, runnerRef }]);
  assert.equal((await f.handler(request)).ok, true);
  f.advance(180_000);
  const observed = await f.handler(
    f.request(
      'operation.get',
      [{ operationId: request.operationId, inputHash: request.inputHash, method: request.method }],
      'readback-1',
    ),
  );
  assert.equal(observed.ok, false);
  assert.equal(observed.error.code, 'LEASE_LOST');
  assert.equal((await f.handler(request)).error.code, 'LEASE_LOST');
});

test('a lease expiring during receipt reads cannot authorize the next cloud write', async (t) => {
  const f = setup(t);
  const request = f.request('acquire', [{ ownerRunId, runnerRef }]);
  assert.equal((await f.handler(request)).ok, true);
  f.advance(179_990);
  const original = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = (callback) =>
    original((tx) =>
      callback({
        collection: (name) => ({
          doc: (key) => {
            const ref = tx.collection(name).doc(key);
            return {
              get: async () => {
                const result = await ref.get();
                if (name === 'siteReleaseTargets') f.advance(20);
                return result;
              },
              set: (value) => ref.set(value),
            };
          },
        }),
      }),
    );
  const result = await f.handler(
    f.request(
      'operation.get',
      [
        {
          operationId: request.operationId,
          inputHash: request.inputHash,
          method: request.method,
        },
      ],
      'readback-expiry',
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LEASE_LOST');
});

test('released terminal receipt remains readable after its lease has gone', async (t) => {
  const f = setup(t);
  const acquired = await f.handler(f.request('acquire', [{ ownerRunId, runnerRef }]));
  const request = f.request('release', [acquired.result], 'release-1');
  assert.equal((await f.handler(request)).ok, true);
  f.advance(180_000);
  const read = await f.handler(
    f.request(
      'operation.get',
      [{ operationId: request.operationId, inputHash: request.inputHash, method: request.method }],
      'readback-1',
    ),
  );
  assert.equal(read.ok, true);
  assert.equal(read.result.result.status, 'released');
});

async function runningPublish(f) {
  let index = 0;
  const call = async (method, ...args) => {
    const result = await f.handler(f.request(method, args, `flow-${++index}`));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  };
  const parts = (label) => ({
    static: {
      ...composition(label).static,
      artifact: { ...composition(label).static.artifact, repository: policy.repository },
    },
  });
  const guard = await call('acquire', { ownerRunId, runnerRef });
  const base = `${ownerRunId}-baseline`;
  await call('startRun', {
    runId: base,
    guard,
    kind: 'adopt',
    scopeKey: 'site',
    composition: parts('A'),
    plan: { ...plan(1), acceptanceHash: 'a'.repeat(64) },
  });
  const accept = await call('beginStep', {
    ...stepInput('accept'),
    beforeHash: 'a'.repeat(64),
    afterHash: 'a'.repeat(64),
    runId: base,
    guard,
  });
  await call('confirmStep', {
    runId: base,
    stepId: accept.stepId,
    guard,
    receipt: receipt(accept),
  });
  await call('commitRun', { runId: base, guard, changeSetRef: 'fixture-accept' });
  const next = await call('acquire', { ownerRunId, runnerRef });
  await call('startRun', {
    runId: ownerRunId,
    guard: next,
    kind: 'publish',
    scopeKey: 'site',
    composition: parts('B'),
    plan: plan(),
    deliveredComponents: ['static'],
  });
  return { call, guard: next };
}

test('beginStep readback requires the same pending step, run and fence', async (t) => {
  const f = setup(t);
  const { call, guard } = await runningPublish(f);
  const request = f.request(
    'beginStep',
    [{ ...stepInput(), runId: ownerRunId, guard }],
    'begin-write',
  );
  const begun = await f.handler(request);
  assert.equal(begun.ok, true);
  const readback = () =>
    f.handler(
      f.request(
        'operation.get',
        [
          {
            operationId: request.operationId,
            inputHash: request.inputHash,
            method: request.method,
          },
        ],
        'readback-1',
      ),
    );
  assert.equal((await readback()).ok, true);
  await call('recordSubmitted', {
    runId: ownerRunId,
    stepId: begun.result.stepId,
    guard,
    receipt: receipt(begun.result, 'submitted'),
  });
  const changed = await readback();
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'RELEASE_REGIONAL_RECEIPT');
});

test('submitted and confirmed receipts survive lost commit replies and keep counters exact', async (t) => {
  const f = setup(t);
  const { call, guard } = await runningPublish(f);
  const step = await call('beginStep', { ...stepInput(), runId: ownerRunId, guard });
  const readback = async (request) => {
    const result = await f.handler(
      f.request(
        'operation.get',
        [
          {
            operationId: request.operationId,
            inputHash: request.inputHash,
            method: request.method,
          },
        ],
        `read-${request.operationId}`,
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result.result;
  };
  for (const method of ['recordSubmitted', 'confirmStep']) {
    const request = f.request(
      method,
      [
        {
          runId: ownerRunId,
          stepId: step.stepId,
          guard,
          receipt: receipt(step, method === 'recordSubmitted' ? 'submitted' : 'verified'),
        },
      ],
      method,
    );
    f.fault.commit('lost-ack');
    assert.equal((await f.handler(request)).ok, false);
    const recovered = await readback(request);
    assert.equal(recovered.state, method === 'recordSubmitted' ? 'submitted' : 'verified');
  }
  const current = await call('runStatus', ownerRunId);
  assert.equal(current.verifiedSteps, 1);
  assert.equal(current.verifiedWrites, 1);
  assert.equal((await call('status')).target.unresolvedOperation, null);
});

test('a receipt from an earlier fence cannot authorize work under a later lease', async (t) => {
  const f = setup(t);
  const request = f.request('acquire', [{ ownerRunId, runnerRef }]);
  const first = await f.handler(request);
  const released = await f.handler(f.request('release', [first.result], 'release-1'));
  assert.equal(released.ok, true);
  const second = await f.handler(f.request('acquire', [{ ownerRunId, runnerRef }], 'acquire-2'));
  assert.equal(second.result.fence, 2);
  const old = await f.handler(
    f.request(
      'operation.get',
      [{ operationId: request.operationId, inputHash: request.inputHash, method: request.method }],
      'readback-1',
    ),
  );
  assert.equal(old.ok, false);
  assert.equal(old.error.code, 'LEASE_LOST');
});

test('a lost SDK commit reply can be confirmed without executing the command again', async (t) => {
  const f = setup(t);
  f.fault.commit('lost-ack');
  const request = f.request('acquire', [{ ownerRunId, runnerRef }]);
  const lost = await f.handler(request);
  assert.equal(lost.ok, false);
  assert.equal(lost.error.code, 'RELEASE_REGIONAL_OPERATION_FAILED');
  const observed = await f.handler(
    f.request(
      'operation.get',
      [
        {
          operationId: request.operationId,
          inputHash: request.inputHash,
          method: request.method,
        },
      ],
      'readback-1',
    ),
  );
  assert.equal(observed.ok, true);
  assert.equal(observed.result.state, 'completed');
  assert.equal(observed.result.result.fence, 1);
  assert.equal(
    f.calls.filter(
      (row) =>
        row.action === 'database.modifyDocument' &&
        row.params.collectionName === 'siteReleaseTargets',
    ).length,
    1,
  );
});

test('a failed ledger write rolls back both the lease and operation receipt', async (t) => {
  const f = setup(t);
  f.fault.set({ data: { updated: 0 }, requestId: 'not-written' });
  const request = f.request('acquire', [{ ownerRunId, runnerRef }]);
  assert.equal((await f.handler(request)).ok, false);
  assert.equal(f.rows.size, 0);
  const observed = await f.handler(
    f.request(
      'operation.get',
      [
        {
          operationId: request.operationId,
          inputHash: request.inputHash,
          method: request.method,
        },
      ],
      'readback-1',
    ),
  );
  assert.deepEqual(observed.result, { state: 'absent' });
  assert.ok(f.calls.some((row) => row.action === 'database.abortTransaction'));
});

test('a failed receipt write rolls back the already-buffered ledger write', async (t) => {
  const f = setup(t);
  const run = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = (callback) =>
    run((tx) =>
      callback({
        collection(name) {
          const collection = tx.collection(name);
          if (name !== 'catalogSeoBuilders') return collection;
          return {
            doc(key) {
              const ref = collection.doc(key);
              return {
                get: () => ref.get(),
                set: async () => {
                  throw Error('secret receipt SDK text');
                },
              };
            },
          };
        },
      }),
    );
  const result = await f.handler(f.request('acquire', [{ ownerRunId, runnerRef }]));
  assert.equal(result.ok, false);
  assert.equal(f.rows.size, 0);
  assert.doesNotMatch(JSON.stringify({ result, logs: f.logs }), /secret/);
});

test('reusing an operation ID with different arguments cannot change the original lease', async (t) => {
  const f = setup(t);
  const acquired = await f.handler(f.request('acquire', [{ ownerRunId, runnerRef }]));
  const changed = await f.handler(f.request('renew', [acquired.result]));
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'RELEASE_REGIONAL_RECEIPT');
  const mismatch = await f.handler(
    f.request(
      'operation.get',
      [
        {
          operationId: 'operation-1',
          inputHash: 'f'.repeat(64),
          method: 'acquire',
        },
      ],
      'readback-1',
    ),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'RELEASE_REGIONAL_RECEIPT');
});

test('authentication, fixed identities, input hash and method validation happen before SDK initialization', async () => {
  let initializations = 0;
  const handler = createReleaseRegionalHandler(config, {
    createDatabase: () => {
      initializations++;
      throw Error('secret database credentials');
    },
    onStatus: () => {},
  });
  const valid = {
    schemaVersion: 1,
    token,
    ownerRunId,
    runnerRef,
    codeSha,
    targetId: config.targetId,
    operationId: 'test-1',
    method: 'status',
    args: [],
  };
  for (const patch of [
    { token: 'c'.repeat(64) },
    { targetId: 'c'.repeat(64) },
    { ownerRunId: 'site-41313740696-1' },
    { codeSha: 'c'.repeat(40) },
    { method: 'deleteFunction' },
    { policy: { envId: 'other' } },
    { method: 'acquire', args: [{ ownerRunId: 'other', runnerRef }] },
  ]) {
    const request = { ...valid, ...patch };
    const result = await handler({ ...request, inputHash: releaseRegionalInputHash(request) });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret|tokenDigest/);
  }
  assert.equal((await handler({ ...valid, inputHash: 'e'.repeat(64) })).ok, false);
  assert.equal(initializations, 0);
});

test('read-only status accepts the original empty-options API and creates no RPC receipt', async (t) => {
  const f = setup(t);
  const result = await f.handler(f.request('status', [{}]));
  assert.equal(result.ok, true);
  assert.equal(result.result.state, 'uninitialized');
  assert.equal(f.rows.size, 0);
});

test('diagnostics keep fixed SDK code, request and ledger stage but never the raw SDK message', async () => {
  const logs = [];
  const handler = createReleaseRegionalHandler(config, {
    createDatabase: () => {
      throw Object.assign(Error('secret https://signed.example/?token=secret'), {
        code: 'ResourceUnavailable.TransactionNotExist',
        requestId: 'b90cf93a-6c8b-4824-a1b7-c3f5bae83c1a',
        ledgerStage: 'write:targets',
      });
    },
    onStatus: (row) => logs.push(row),
  });
  const request = {
    schemaVersion: 1,
    token,
    ownerRunId,
    runnerRef,
    codeSha,
    targetId: config.targetId,
    operationId: 'test-1',
    method: 'status',
    args: [],
  };
  const result = await handler({ ...request, inputHash: releaseRegionalInputHash(request) });
  assert.equal(result.error.diagnostic.sdkCode, 'ResourceUnavailable.TransactionNotExist');
  assert.equal(result.error.diagnostic.ledgerStage, 'write:targets');
  assert.doesNotMatch(JSON.stringify({ result, logs }), /secret|signed\.example/);
});
