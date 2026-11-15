import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readCompleteFunctionInventory } from './release/function-inventory.mjs';

const envId = 'fixture-env';
const rows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    FunctionName: `function-${index}`,
    Namespace: envId,
  }));
function fixture(items = []) {
  const calls = [];
  const functions = {
    getFunctionList: async (limit, offset) => {
      calls.push([limit, offset]);
      return {
        RequestId: `page-${offset}`,
        TotalCount: items.length,
        Functions: items.slice(offset, offset + limit),
      };
    },
  };
  return { functions, calls };
}
const rejects = (functions, expectedEnv = envId) =>
  assert.rejects(readCompleteFunctionInventory(functions, expectedEnv), {
    code: 'FUNCTION_INVENTORY_UNPROVEN',
  });

test('only an explicit zero total and empty raw page prove an empty inventory', async () => {
  const f = fixture();
  assert.deepEqual(await readCompleteFunctionInventory(f.functions, envId), []);
  assert.deepEqual(f.calls, [[100, 0]]);
});

test('a single raw response covers the exact count, including a full page of 100', async () => {
  for (const count of [1, 99, 100]) {
    const f = fixture(rows(count));
    const names = await readCompleteFunctionInventory(f.functions, envId);
    assert.equal(names.length, count);
    assert.equal(names[0], 'function-0');
    assert.equal(names.at(-1), `function-${count - 1}`);
    assert.deepEqual(f.calls, [[100, 0]]);
  }
});

test('a changing multi-page list cannot prove absence even when count and returned names stay unique', async () => {
  const before = [...rows(100), { FunctionName: 'old-worker', Namespace: envId }];
  const after = [...before.slice(1), { FunctionName: 'new-unrelated', Namespace: envId }];
  const calls = [];
  const functions = {
    getFunctionList: async (limit, offset) => {
      calls.push([limit, offset]);
      return {
        RequestId: `page-${offset}`,
        TotalCount: 101,
        Functions: (offset === 0 ? before : after).slice(offset, offset + limit),
      };
    },
  };
  await rejects(functions);
  assert.deepEqual(calls, [[100, 0]]);
});

test('missing response fields and invalid counts cannot prove absence', async () => {
  const valid = { RequestId: 'page-0', TotalCount: 0, Functions: [] };
  for (const field of ['RequestId', 'TotalCount', 'Functions']) {
    const response = { ...valid };
    delete response[field];
    await rejects({ getFunctionList: async () => response });
  }
  for (const response of [
    null,
    { ...valid, RequestId: '' },
    { ...valid, RequestId: '  ' },
    { ...valid, RequestId: 1 },
    ...[-1, 1001, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '0', null].map((TotalCount) => ({
      ...valid,
      TotalCount,
    })),
    { ...valid, Functions: null },
    { ...valid, Functions: {} },
    { ...valid, Functions: rows(1) },
    { ...valid, TotalCount: 1 },
    { ...valid, TotalCount: 101, Functions: rows(99) },
    { ...valid, TotalCount: 100, Functions: rows(101) },
  ])
    await rejects({ getFunctionList: async () => response });
});

test('101 or more functions require an exact-absence contract and never request a second page', async () => {
  for (const count of [101, 119, 201, 1000]) {
    const f = fixture(rows(count));
    await rejects(f.functions);
    assert.deepEqual(f.calls, [[100, 0]]);
  }
});

test('every function belongs to the fixed namespace and has a unique nonempty name', async () => {
  for (const row of [
    null,
    {},
    { FunctionName: 'function-0' },
    { FunctionName: 'function-0', Namespace: 'other-env' },
    { FunctionName: '', Namespace: envId },
    { FunctionName: '  ', Namespace: envId },
    { FunctionName: 1, Namespace: envId },
  ])
    await rejects(fixture([row]).functions);
  await rejects(fixture([rows(1)[0], rows(1)[0]]).functions);
  const duplicate = rows(100);
  duplicate[99].FunctionName = 'function-0';
  await rejects(fixture(duplicate).functions);
});

test('the raw listing method and an explicit environment are required; transport failures stop', async () => {
  await rejects({ listFunctions: async () => [] });
  await rejects(null);
  await rejects(fixture().functions, '');
  const cause = Object.assign(Error('Permission denied'), { code: 'AuthFailure' });
  await assert.rejects(
    readCompleteFunctionInventory(
      {
        getFunctionList: async () => {
          throw cause;
        },
      },
      envId,
    ),
    (error) => error === cause,
  );
});

test('installed Manager retains raw count and namespace while its convenience list hides incomplete responses', async () => {
  const require = createRequire(new URL('../package.json', import.meta.url));
  const Manager = require('@cloudbase/manager-node');
  let response = { RequestId: 'sdk-list', TotalCount: 2 };
  const calls = [];
  const manager = new Manager({
    envId,
    region: 'ap-shanghai',
    requestFn: async ({ service, action, payload }) => {
      calls.push({ service, action, payload });
      if (action === 'DescribeEnvInfo')
        return { EnvInfo: { EnvBaseInfo: { EnvId: envId, Functions: [{ Namespace: envId }] } } };
      assert.equal(service, 'tcb');
      assert.equal(action, 'ListFunctions');
      assert.deepEqual(payload, { EnvId: envId, Limit: 100, Offset: 0 });
      return structuredClone(response);
    },
  });
  assert.deepEqual(await manager.functions.listFunctions(100, 0), []);
  assert.deepEqual(await manager.functions.getFunctionList(100, 0), response);
  await rejects(manager.functions);
  response = { RequestId: 'sdk-list', TotalCount: 2, Functions: rows(1) };
  assert.equal((await manager.functions.listFunctions(100, 0)).length, 1);
  await rejects(manager.functions);
  response = { RequestId: 'sdk-list', TotalCount: 1, Functions: rows(1) };
  assert.deepEqual(await readCompleteFunctionInventory(manager.functions, envId), ['function-0']);
  assert.equal(calls.filter((call) => call.action === 'DescribeEnvInfo').length, 1);
});
