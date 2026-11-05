import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import { createReleaseRegionalClient } from './release-regional-client.mjs';
import { createReleaseRegionalHandler } from './release/regional-coordinator.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';

const ownerRunId = 'site-41313740695-1';
const runnerRef = 'github:vibelingan/channel:41313740695:attempt-1';
const codeSha = 'b'.repeat(40);
async function fixture(t) {
  const wire = cloudbaseFixture(t);
  wire.db.config.env = policy.envId;
  const directory = await mkdtemp(join(tmpdir(), 'release-region-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const functions = new Map();
  const calls = [];
  const f = { ...wire, directory, functions, calls, requests: [], deleted: [], created: [] };
  const manager = {
    getManagerConfig: () => ({ envId: policy.envId, region: policy.region }),
    functions: {
      getFunctionList: async (limit, offset) => {
        assert.deepEqual([limit, offset], [100, 0]);
        const listed = completeInventory(f);
        // A deleted function can stay listed for several reads before it disappears.
        if (f.listedAfterDelete > 0 && f.deleted.length && --f.listedAfterDelete === 0)
          functions.delete(f.deleted.at(-1));
        return listed;
      },
      async createFunction({ func, force }) {
        f.created.push(func.name);
        assert.equal(force, false);
        assert.equal(func.type, 'Event');
        const vars = func.envVariables;
        f.handler = createReleaseRegionalHandler(
          {
            envId: vars.TCB_ENV,
            targetId: vars.RELEASE_REGIONAL_TARGET_ID,
            ownerRunId,
            runnerRef,
            codeSha,
            tokenDigest: vars.RELEASE_REGIONAL_TOKEN_DIGEST,
          },
          {
            createDatabase: () => wire.db,
            onStatus: () => {},
          },
        );
        functions.set(func.name, {
          FunctionName: func.name,
          Description: func.description,
          Type: func.type,
          Runtime: func.runtime,
          Handler: func.handler,
          Triggers: [],
          Status: 'Active',
          AvailableStatus: 'Available',
          Environment: { Variables: Object.entries(vars).map(([Key, Value]) => ({ Key, Value })) },
        });
        if (f.lostCreate) throw Error('secret create response');
      },
      getFunctionDetail: async (name) => functions.get(name),
      async deleteFunction(name) {
        f.deleted.push(name);
        if (!f.keepFunction && !f.listedAfterDelete) functions.delete(name);
        if (f.lostDelete) throw Error('secret delete response');
      },
      async invokeFunction(name, request) {
        calls.push(request.method);
        f.requests.push(structuredClone(request));
        if (f.failBeforeInvoke === request.method)
          throw Object.assign(Error('secret timeout'), { code: 'ETIMEDOUT' });
        const result = await f.handler(request);
        if (f.loseReply === request.method) {
          f.loseReply = null;
          throw Error('secret transport error');
        }
        if (f.loseReadback && request.method === 'operation.get')
          throw Error('secret readback error');
        if (f.badReadbackResult && request.method === 'operation.get' && result.ok)
          result.result.result = { ...result.result.result, ownerRunId: 'other-owner' };
        return {
          RequestId: 'cloud-request',
          RetCode: 0,
          InvokeFinished: 1,
          RetMsg: JSON.stringify(
            f.badEnvelope && request.method !== 'health'
              ? { ...result, codeSha: 'c'.repeat(40) }
              : result,
          ),
        };
      },
    },
  };
  f.manager = manager;
  f.start = (overrides = {}) =>
    createReleaseRegionalClient({
      manager,
      policy,
      ownerRunId,
      runnerRef,
      codeSha,
      directory,
      build: async () => {},
      wait: async () => {},
      mask: () => {},
      onStatus: () => {},
      ...overrides,
    });
  return f;
}

function installedInventory(f, response) {
  const require = createRequire(new URL('../package.json', import.meta.url));
  const Manager = require('@cloudbase/manager-node');
  f.inventoryCalls = [];
  const actual = new Manager({
    envId: policy.envId,
    region: policy.region,
    requestFn: async ({ service, action, payload }) => {
      if (action === 'DescribeEnvInfo')
        return {
          EnvInfo: {
            EnvBaseInfo: { EnvId: policy.envId, Functions: [{ Namespace: policy.envId }] },
          },
        };
      assert.equal(service, 'tcb');
      assert.equal(action, 'ListFunctions');
      assert.deepEqual(payload, { EnvId: policy.envId, Limit: 100, Offset: 0 });
      f.inventoryCalls.push(payload);
      return response();
    },
  });
  f.manager.functions.listFunctions = actual.functions.listFunctions.bind(actual.functions);
  f.manager.functions.getFunctionList = actual.functions.getFunctionList.bind(actual.functions);
}
function completeInventory(f) {
  return {
    RequestId: 'offline-function-list',
    TotalCount: f.functions.size,
    Functions: [...f.functions.values()].map((row) => ({ Namespace: policy.envId, ...row })),
  };
}

function failTransactionStarts(f, method, count = 1, code = 'DATABASE_TRANSACTION_FAIL') {
  const transact = f.db.runTransaction.bind(f.db);
  let remaining = count;
  f.db.runTransaction = async (callback) => {
    if (f.requests.at(-1)?.method === method && remaining-- > 0)
      throw Object.assign(Error('PRIVATE_TRANSACTION_START_FAILURE'), { code });
    return transact(callback);
  };
}

test('lost reply is resolved from the atomic receipt without resubmitting the lease write', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'acquire';
  const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
  assert.equal(guard.fence, 1);
  assert.equal(f.calls.filter((method) => method === 'acquire').length, 1);
  assert.equal(f.calls.filter((method) => method === 'operation.get').length, 1);
  await client.coordinator.release(guard);
  await client.close();
  assert.deepEqual(f.deleted, ['seo-release-region-41313740695-1']);
  assert.equal(client.unconfirmed, false);
});

test('a renewal whose transaction never started retries once after an absent receipt using the identical request', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
  const before = await client.coordinator.status();
  failTransactionStarts(f, 'renew');

  assert.deepEqual(await client.coordinator.renew(guard), guard);
  const requests = f.requests.filter((request) => request.method === 'renew');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(f.calls.filter((method) => method === 'operation.get').length, 1);
  const after = await client.coordinator.status();
  assert.equal(after.target.version, before.target.version + 1);
  assert.equal(client.unconfirmed, false);
  const receipt = JSON.parse(await readFile(join(f.directory, 'result.json'), 'utf8'));
  assert.equal(receipt.calls.filter((row) => row.method === 'renew').length, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_TRANSACTION_START_FAILURE|"token"/);
  await client.coordinator.release(guard);
  assert.deepEqual(await client.close(), { cleaned: true, unconfirmed: false });
});

test('a completed renewal receipt resolves the first lost reply without another write', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
  const before = await client.coordinator.status();
  const invoke = f.manager.functions.invokeFunction;
  let lost = false;
  f.manager.functions.invokeFunction = async (name, request) => {
    const result = await invoke(name, request);
    if (request.method === 'renew' && !lost) {
      lost = true;
      throw Object.assign(Error('PRIVATE_LOST_RENEWAL_REPLY'), {
        code: 'DATABASE_TRANSACTION_FAIL',
        ledgerStage: 'awaiting-sdk-transaction',
      });
    }
    return result;
  };
  assert.deepEqual(await client.coordinator.renew(guard), guard);
  assert.equal(f.calls.filter((method) => method === 'renew').length, 1);
  assert.equal(f.calls.filter((method) => method === 'operation.get').length, 1);
  assert.equal((await client.coordinator.status()).target.version, before.target.version + 1);
  await client.coordinator.release(guard);
  assert.deepEqual(await client.close(), { cleaned: true, unconfirmed: false });
});

test('caller changes during readback cannot change the renewal request being retried', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
  const original = structuredClone(guard);
  failTransactionStarts(f, 'renew');
  const invoke = f.manager.functions.invokeFunction;
  let attempts = 0;
  f.manager.functions.invokeFunction = async (name, request) => {
    const response = await invoke(name, request);
    if (request.method === 'renew' && ++attempts === 1) guard.fence = 999;
    return response;
  };
  assert.deepEqual(await client.coordinator.renew(guard), original);
  const requests = f.requests.filter((request) => request.method === 'renew');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  await client.coordinator.release(original);
  assert.deepEqual(await client.close(), { cleaned: true, unconfirmed: false });
});

test('a lost retry reply is resolved by one final readback of the original renewal', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
  const before = await client.coordinator.status();
  failTransactionStarts(f, 'renew');
  const invoke = f.manager.functions.invokeFunction;
  let attempts = 0;
  f.manager.functions.invokeFunction = async (name, request) => {
    if (request.method === 'renew' && ++attempts === 2) f.loseReply = 'renew';
    return invoke(name, request);
  };
  assert.deepEqual(await client.coordinator.renew(guard), guard);
  const renewals = f.requests.filter((request) => request.method === 'renew');
  const reads = f.requests.filter((request) => request.method === 'operation.get');
  assert.equal(renewals.length, 2);
  assert.deepEqual(renewals[1], renewals[0]);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1], reads[0]);
  assert.equal((await client.coordinator.status()).target.version, before.target.version + 1);
  const receipt = JSON.parse(await readFile(join(f.directory, 'result.json'), 'utf8'));
  assert.equal(receipt.calls.find((row) => row.method === 'renew').state, 'readback-confirmed');
  await client.coordinator.release(guard);
  assert.deepEqual(await client.close(), { cleaned: true, unconfirmed: false });
});

test('a second absent renewal receipt stops after two attempts and retains the worker', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
  failTransactionStarts(f, 'renew', 2);
  await assert.rejects(client.coordinator.renew(guard), { code: 'RELEASE_REGIONAL_UNCONFIRMED' });
  assert.equal(f.calls.filter((method) => method === 'renew').length, 2);
  assert.equal(f.calls.filter((method) => method === 'operation.get').length, 2);
  const count = f.calls.length;
  await assert.rejects(client.coordinator.renew(guard), /Unconfirmed release operation/);
  assert.equal(f.calls.length, count);
  assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true });
  assert.equal(f.deleted.length, 0);
});

test('transaction-start absence never permits retrying another mutation or another diagnostic', async (t) => {
  for (const variant of ['acquire', 'release', 'wrong-code', 'wrong-stage', 'missing-stage']) {
    const f = await fixture(t);
    const client = await f.start();
    const guard =
      variant === 'acquire' ? null : await client.coordinator.acquire({ ownerRunId, runnerRef });
    const method = ['acquire', 'release'].includes(variant) ? variant : 'renew';
    const before = f.calls.filter((value) => value === method).length;
    failTransactionStarts(
      f,
      method,
      1,
      variant === 'wrong-code' ? 'DATABASE_TRANSACTION_CONFLICT' : undefined,
    );
    if (['wrong-stage', 'missing-stage'].includes(variant)) {
      const invoke = f.manager.functions.invokeFunction;
      f.manager.functions.invokeFunction = async (name, request) => {
        const response = await invoke(name, request);
        if (request.method === 'renew') {
          const result = JSON.parse(response.RetMsg);
          if (variant === 'wrong-stage') result.error.diagnostic.ledgerStage = 'callback-completed';
          else result.error.diagnostic.ledgerStage = undefined;
          response.RetMsg = JSON.stringify(result);
        }
        return response;
      };
    }
    const operation =
      method === 'acquire'
        ? client.coordinator.acquire({ ownerRunId, runnerRef })
        : client.coordinator[method](guard);
    await assert.rejects(operation, { code: 'RELEASE_REGIONAL_UNCONFIRMED' }, variant);
    assert.equal(f.calls.filter((value) => value === method).length - before, 1, variant);
    assert.equal(f.calls.filter((value) => value === 'operation.get').length, 1, variant);
    assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true }, variant);
  }
});

test('unreadable or malformed first readback cannot authorize a renewal retry', async (t) => {
  for (const variant of ['transport', 'malformed-absence', 'wrong-source']) {
    const f = await fixture(t);
    const client = await f.start();
    const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
    failTransactionStarts(f, 'renew');
    const invoke = f.manager.functions.invokeFunction;
    f.manager.functions.invokeFunction = async (name, request) => {
      if (request.method === 'operation.get' && variant === 'transport') f.loseReadback = true;
      const response = await invoke(name, request);
      if (request.method === 'operation.get') {
        const result = JSON.parse(response.RetMsg);
        if (variant === 'malformed-absence') result.result.method = 'renew';
        if (variant === 'wrong-source') result.codeSha = 'c'.repeat(40);
        response.RetMsg = JSON.stringify(result);
      }
      return response;
    };
    await assert.rejects(
      client.coordinator.renew(guard),
      { code: 'RELEASE_REGIONAL_UNCONFIRMED' },
      variant,
    );
    assert.equal(f.calls.filter((value) => value === 'renew').length, 1, variant);
    assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true }, variant);
  }
});

test('a failed or invalid final retry readback retains the worker without a third write', async (t) => {
  for (const variant of ['transport', 'wrong-guard', 'wrong-operation']) {
    const f = await fixture(t);
    const client = await f.start();
    const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
    failTransactionStarts(f, 'renew');
    const invoke = f.manager.functions.invokeFunction;
    let attempts = 0;
    let reads = 0;
    f.manager.functions.invokeFunction = async (name, request) => {
      if (request.method === 'renew' && ++attempts === 2) f.loseReply = 'renew';
      if (request.method === 'operation.get' && ++reads === 2) {
        if (variant === 'transport') f.loseReadback = true;
        if (variant === 'wrong-guard') f.badReadbackResult = true;
      }
      const response = await invoke(name, request);
      if (request.method === 'operation.get' && reads === 2 && variant === 'wrong-operation') {
        const result = JSON.parse(response.RetMsg);
        result.result.operationId = 'another-operation';
        response.RetMsg = JSON.stringify(result);
      }
      return response;
    };
    await assert.rejects(
      client.coordinator.renew(guard),
      { code: 'RELEASE_REGIONAL_UNCONFIRMED' },
      variant,
    );
    assert.equal(attempts, 2, variant);
    assert.equal(reads, 2, variant);
    assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true }, variant);
    assert.equal(f.deleted.length, 0, variant);
  }
});

test('unconfirmed mutation retains the function and rejects every following coordinator command', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'acquire';
  f.loseReadback = true;
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), {
    code: 'RELEASE_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  const count = f.calls.length;
  await assert.rejects(client.coordinator.status());
  assert.equal(f.calls.length, count);
  assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true });
  assert.equal(f.deleted.length, 0);
  const evidence = await readFile(join(f.directory, 'result.json'), 'utf8');
  assert.doesNotMatch(evidence, /secret|tokenDigest|"token"/);
  assert.equal(JSON.parse(evidence).unconfirmed, true);
});

test('an absent receipt after transport failure does not authorize replaying the write', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.failBeforeInvoke = 'acquire';
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), (cause) => {
    assert.equal(cause.code, 'RELEASE_REGIONAL_UNCONFIRMED');
    assert.equal(cause.sdkCode, 'ETIMEDOUT');
    assert.doesNotMatch(cause.message, /secret/);
    return true;
  });
  assert.equal(f.calls.filter((method) => method === 'acquire').length, 1);
  assert.equal(f.rows.size, 0);
  assert.equal((await client.close()).cleaned, false);
});

test('safe status can be read again after a lost reply without creating mutation receipts', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'status';
  assert.equal((await client.coordinator.status({})).state, 'uninitialized');
  assert.equal(f.calls.filter((method) => method === 'status').length, 2);
  assert.equal(f.rows.size, 0);
  await client.close();
});

test('an invocation with the wrong runtime source identity is never accepted', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.badEnvelope = true;
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), {
    code: 'RELEASE_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  assert.equal((await client.close()).cleaned, false);
});

test('lost create and delete replies are resolved only by exact owned inventory readback', async (t) => {
  const f = await fixture(t);
  f.lostCreate = true;
  f.lostDelete = true;
  const client = await f.start();
  assert.deepEqual(await client.close(), { cleaned: true, unconfirmed: false });
  assert.equal(f.functions.size, 0);
});

test('an occupied or foreign function is never replaced or deleted', async (t) => {
  const f = await fixture(t);
  const name = 'seo-release-region-41313740695-1';
  f.functions.set(name, { FunctionName: name, Description: 'another app' });
  await assert.rejects(f.start(), { code: 'RELEASE_REGIONAL_PREPARATION_FAILED' });
  assert.equal(f.functions.get(name).Description, 'another app');
  assert.deepEqual(f.deleted, []);
});

test('a deleted function that stays listed for a while is still confirmed absent within a minute', async (t) => {
  const f = await fixture(t);
  const waits = [];
  const client = await f.start({ wait: async (ms) => waits.push(ms) });
  // Run 41878896329 stopped because six checks over ~8 s still listed the deleted function.
  f.listedAfterDelete = 10;
  assert.deepEqual(await client.close(), { cleaned: true, unconfirmed: false });
  assert.equal(f.functions.size, 0);
  assert.ok(waits.length >= 6);
  assert.ok(waits.reduce((total, ms) => total + ms, 0) < 60_000);
});

test('a function still listed after every absence check stays unconfirmed after about a minute', async (t) => {
  const f = await fixture(t);
  const waits = [];
  const client = await f.start({ wait: async (ms) => waits.push(ms) });
  f.keepFunction = true;
  await assert.rejects(client.close(), { code: 'RELEASE_REGIONAL_UNCONFIRMED' });
  assert.equal(waits.length, 15);
  assert.equal(
    waits.reduce((total, ms) => total + ms, 0),
    57_750,
  );
  assert.equal(f.functions.size, 1);
});

test('cleanup uncertainty is explicit and retains the original function', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.keepFunction = true;
  await assert.rejects(client.close(), { code: 'RELEASE_REGIONAL_UNCONFIRMED' });
  assert.equal(client.unconfirmed, true);
  assert.equal(f.functions.size, 1);
});

test('another owner or cloud environment is rejected before function creation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.start({ ownerRunId: 'site-41313740696-1' }));
  await assert.rejects(f.start({ policy: { ...policy, envId: 'other-env' } }));
  assert.equal(f.functions.size, 0);
});

test('a receipt result must pass the same guard checks as a normal response', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'acquire';
  f.badReadbackResult = true;
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), {
    code: 'RELEASE_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  assert.equal((await client.close()).cleaned, false);
});

test('actual Manager missing Functions cannot confirm a failed deletion', async (t) => {
  const f = await fixture(t);
  installedInventory(f, () =>
    f.deleted.length
      ? { RequestId: 'offline-incomplete-list', TotalCount: f.functions.size }
      : completeInventory(f),
  );
  const client = await f.start();
  f.keepFunction = true;
  f.lostDelete = true;
  await assert.rejects(client.close(), { code: 'RELEASE_REGIONAL_UNCONFIRMED' });
  assert.equal(f.functions.size, 1);
  assert.equal(client.unconfirmed, true);
  const receipt = JSON.parse(await readFile(join(f.directory, 'result.json'), 'utf8'));
  assert.equal(receipt.cleaned, false);
  assert.equal(receipt.unconfirmed, true);
  assert.equal(f.deleted.length, 1);
  const invokeCount = f.calls.length;
  const inventoryCount = f.inventoryCalls.length;
  assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true });
  await assert.rejects(client.coordinator.status(), /Unconfirmed release operation/);
  assert.equal(f.calls.length, invokeCount);
  assert.equal(f.deleted.length, 1);
  assert.equal(f.inventoryCalls.length, inventoryCount);
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
});

test('invalid raw inventory cannot create a regional worker', async (t) => {
  const wrong = { FunctionName: 'other-app', Namespace: 'wrong-env' };
  for (const response of [
    { RequestId: 'offline-list', TotalCount: 0 },
    { RequestId: 'offline-list', TotalCount: 1, Functions: [] },
    { TotalCount: 0, Functions: [] },
    { RequestId: 'offline-list', TotalCount: 1, Functions: [wrong] },
    {
      RequestId: 'offline-list',
      TotalCount: 2,
      Functions: [
        { ...wrong, Namespace: policy.envId },
        { ...wrong, Namespace: policy.envId },
      ],
    },
    { RequestId: 'offline-list', TotalCount: 101, Functions: [] },
  ]) {
    const f = await fixture(t);
    installedInventory(f, () => response);
    await assert.rejects(f.start());
    assert.deepEqual(f.created, []);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.functions.size, 0);
    assert.equal(f.inventoryCalls.length, 1);
  }
});

test('a malformed deletion readback leaves cleanup explicitly unconfirmed', async (t) => {
  for (const invalid of [
    { RequestId: 'offline-list', TotalCount: 1, Functions: [] },
    {
      RequestId: 'offline-list',
      TotalCount: 1,
      Functions: [{ FunctionName: 'other-app', Namespace: 'wrong-env' }],
    },
    { RequestId: 'offline-list', TotalCount: 101, Functions: [] },
    () => {
      throw Object.assign(Error('PRIVATE_CLEANUP_SECRET'), { code: 'AuthFailure' });
    },
  ]) {
    const f = await fixture(t);
    installedInventory(f, () =>
      f.deleted.length
        ? typeof invalid === 'function'
          ? invalid()
          : invalid
        : completeInventory(f),
    );
    const client = await f.start();
    f.keepFunction = true;
    await assert.rejects(
      client.close(),
      (error) =>
        error.code === 'RELEASE_REGIONAL_UNCONFIRMED' &&
        !error.message.includes('PRIVATE_CLEANUP_SECRET'),
    );
    assert.equal(client.unconfirmed, true);
    const receipt = JSON.parse(await readFile(join(f.directory, 'result.json'), 'utf8'));
    assert.equal(receipt.cleaned, false);
    assert.equal(receipt.unconfirmed, true);
    assert.equal(JSON.stringify(receipt).includes('PRIVATE_CLEANUP_SECRET'), false);
    assert.equal(f.functions.size, 1);
    assert.equal(f.deleted.length, 1);
  }
});
