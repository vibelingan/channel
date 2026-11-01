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
  const f = { ...wire, directory, functions, calls, deleted: [], created: [] };
  const manager = {
    getManagerConfig: () => ({ envId: policy.envId, region: policy.region }),
    functions: {
      getFunctionList: async (limit, offset) => {
        assert.deepEqual([limit, offset], [100, 0]);
        return completeInventory(f);
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
        if (!f.keepFunction) functions.delete(name);
        if (f.lostDelete) throw Error('secret delete response');
      },
      async invokeFunction(name, request) {
        calls.push(request.method);
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
