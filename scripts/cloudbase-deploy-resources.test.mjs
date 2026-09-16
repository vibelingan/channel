import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertToolSucceeded,
  ensureGateway,
  reconcileTriggers,
  requestIdFrom,
  toolMessage,
} from './cloudbase-deploy-resources.mjs';
import { ALIBABA_SYNC_TIMER, desiredTriggersFor } from './cloudbase-function-manifest.mjs';

const def = { name: 'alibaba-catalog-sync', routePath: '/api/alibaba-catalog-sync' };
const desired = [ALIBABA_SYNC_TIMER];
const timer = (overrides = {}) => ({
  TriggerName: ALIBABA_SYNC_TIMER.name,
  Type: ALIBABA_SYNC_TIMER.type,
  TriggerDesc: ALIBABA_SYNC_TIMER.config,
  ...overrides,
});
const detail = (triggers = []) => ({
  success: true,
  data: { functionDetail: { Triggers: triggers } },
});
const failure = (data = {}) => ({ success: false, message: 'operation refused', data });

function tools(...responses) {
  const calls = [];
  const messages = [];
  return {
    calls,
    messages,
    logger: { log: (message) => messages.push(message) },
    callTool(selector, args, options) {
      calls.push({ selector, args, options });
      assert.ok(responses.length, `unexpected call ${selector}/${args.action}`);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

for (const apis of [[], [{ Path: def.routePath }]]) {
  test(`gateway query failure stops even with ${apis.length} returned routes`, () => {
    const client = tools(failure({ apis }), { success: true });
    assert.throws(() => ensureGateway(def, client), /getAccess.*failed.*operation refused/);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.messages, []);
  });
}

test('gateway creation failure cannot be reported as created', () => {
  const client = tools({ success: true, data: { apis: [] } }, failure());
  assert.throws(() => ensureGateway(def, client), /createAccess.*failed.*operation refused/);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.messages, []);
});

test('gateway preserves existing query/create API arguments', () => {
  const client = tools({ data: { apis: [] } }, { data: { raw: { RequestId: 'created-id' } } });
  ensureGateway(def, client);
  assert.deepEqual(
    client.calls.map(({ selector, args }) => ({ selector, args })),
    [
      {
        selector: 'cloudbase.queryGateway',
        args: { action: 'getAccess', targetType: 'function', targetName: def.name },
      },
      {
        selector: 'cloudbase.manageGateway',
        args: {
          action: 'createAccess',
          targetType: 'function',
          targetName: def.name,
          path: def.routePath,
          type: 'Event',
          auth: false,
        },
      },
    ],
  );
  assert.match(client.messages[0], /created gateway route.*created-id/);
});

for (const data of [
  { apis: [{ Path: def.routePath }] },
  { raw: { accessList: { APISet: [{ Path: def.routePath }] } } },
]) {
  test('gateway recognizes the existing route without creating another', () => {
    const client = tools({ success: true, data });
    ensureGateway(def, client);
    assert.equal(client.calls.length, 1);
  });
}

for (const queryIndex of [0, 1, 2]) {
  test(`trigger query ${queryIndex + 1} rejects a negative envelope before continuing`, () => {
    const responses = [detail([timer()]), detail([timer()]), detail([timer()])];
    responses[queryIndex] = failure({ functionDetail: { Triggers: [timer()] } });
    const client = tools(...responses);
    assert.throws(
      () => reconcileTriggers(def, desired, client),
      /getFunctionDetail.*failed.*operation refused/,
    );
    assert.equal(client.calls.length, queryIndex + 1);
  });
}

test('trigger deletion failure stops before another read or create', () => {
  const client = tools(detail([timer()]), failure(), detail(), detail());
  assert.throws(
    () => reconcileTriggers(def, [], client),
    /deleteFunctionTrigger.*failed.*operation refused/,
  );
  assert.equal(client.calls.length, 2);
});

test('trigger creation failure stops even if a later read would look correct', () => {
  const client = tools(detail(), detail(), failure(), detail([timer()]));
  assert.throws(
    () => reconcileTriggers(def, desired, client),
    /createFunctionTrigger.*failed.*operation refused/,
  );
  assert.equal(client.calls.length, 3);
});

for (const overrides of [{ TriggerDesc: '0 * * * * * *' }, { Type: 'http' }]) {
  test(`final trigger comparison rejects same-name drift: ${JSON.stringify(overrides)}`, () => {
    const client = tools(detail([timer()]), detail([timer()]), detail([timer(overrides)]));
    assert.throws(() => reconcileTriggers(def, desired, client), /trigger reconcile failed/);
    assert.equal(client.calls.length, 3);
  });
}

for (const overrides of [{ TriggerDesc: '0 * * * * * *' }, { Type: 'http' }]) {
  test(`trigger reconciliation replaces existing drift: ${JSON.stringify(overrides)}`, () => {
    const client = tools(
      detail([timer(overrides)]),
      { success: true },
      detail(),
      { success: true },
      detail([timer()]),
    );
    reconcileTriggers(def, desired, client);
    assert.deepEqual(
      client.calls.map(({ args }) => args.action),
      [
        'getFunctionDetail',
        'deleteFunctionTrigger',
        'getFunctionDetail',
        'createFunctionTrigger',
        'getFunctionDetail',
      ],
    );
    assert.deepEqual(client.calls[1].args, {
      action: 'deleteFunctionTrigger',
      functionName: def.name,
      triggerName: ALIBABA_SYNC_TIMER.name,
    });
    assert.deepEqual(client.calls[3].args, {
      action: 'createFunctionTrigger',
      functionName: def.name,
      triggers: desired,
    });
  });
}

test('manual-only manifest removes an undeclared timer without enabling a scheduler', () => {
  assert.deepEqual(desiredTriggersFor(def.name), []);
  const client = tools(detail([timer()]), { success: true }, detail(), detail());
  reconcileTriggers(def, desiredTriggersFor(def.name), client);
  assert.deepEqual(
    client.calls.map(({ args }) => args.action),
    ['getFunctionDetail', 'deleteFunctionTrigger', 'getFunctionDetail', 'getFunctionDetail'],
  );
});

test('transport errors propagate unchanged from gateway and every trigger operation', () => {
  for (const [run, responses] of [
    [ensureGateway, []],
    [ensureGateway, [{ data: { apis: [] } }]],
    [(definition, client) => reconcileTriggers(definition, [], client), []],
    [(definition, client) => reconcileTriggers(definition, [], client), [detail([timer()])]],
    [(definition, client) => reconcileTriggers(definition, [], client), [detail()]],
    [(definition, client) => reconcileTriggers(definition, desired, client), [detail(), detail()]],
    [(definition, client) => reconcileTriggers(definition, [], client), [detail(), detail()]],
  ]) {
    const error = new Error('redacted mcporter transport failure');
    const client = tools(...responses, error);
    assert.throws(
      () => run(def, client),
      (thrown) => thrown === error,
    );
    assert.equal(client.calls.length, responses.length + 1);
  }
});

test('tool assertions retain missing-success compatibility and summarized error details', () => {
  for (const result of [{}, { data: {} }, { success: true }]) {
    assert.doesNotThrow(() => assertToolSucceeded(result, 'operation'));
  }
  for (const result of [null, undefined, 'not an object']) {
    assert.throws(() => assertToolSucceeded(result, 'operation'), /returned no result object/);
  }
  const result = {
    success: false,
    data: {
      raw: { Code: 'DENIED', Message: 'refused', RequestId: 'request-id' },
      envVariables: { JWT_SECRET: 'not-for-logging' },
    },
  };
  assert.equal(requestIdFrom(result), 'request-id');
  assert.throws(() => assertToolSucceeded(result, 'operation'), /operation failed:.*DENIED/);
  assert.doesNotMatch(toolMessage(result), /not-for-logging/);
});

for (const queryIndex of [0, 1, 2]) {
  test(`manual-only trigger query ${queryIndex + 1} must not turn failure into an empty list`, () => {
    const responses = [detail(), detail(), detail()];
    responses[queryIndex] = failure();
    const client = tools(...responses);
    assert.throws(
      () => reconcileTriggers(def, desiredTriggersFor(def.name), client),
      /getFunctionDetail.*failed.*operation refused/,
    );
    assert.equal(client.calls.length, queryIndex + 1);
  });
}

for (const finalTriggers of [
  [],
  [timer(), timer()],
  [timer(), timer({ TriggerName: 'unexpected' })],
]) {
  test(`final comparison rejects missing, duplicate or extra triggers: ${JSON.stringify(finalTriggers)}`, () => {
    const client = tools(detail([timer()]), detail([timer()]), detail(finalTriggers));
    assert.throws(() => reconcileTriggers(def, desired, client), /trigger reconcile failed/);
  });
}

test('equivalent reordered trigger readback preserves type and schedule without mutation', () => {
  const second = { ...ALIBABA_SYNC_TIMER, name: 'another-test-timer' };
  const wanted = [...desired, second];
  const existing = [timer(), second];
  const client = tools(detail(existing), detail(existing), detail([...existing].reverse()));
  reconcileTriggers(def, wanted, client);
  assert.ok(client.calls.every(({ args }) => args.action === 'getFunctionDetail'));
});

test('an acknowledged but ineffective trigger deletion fails final readback', () => {
  const stale = [timer({ TriggerDesc: '0 * * * * * *' })];
  const client = tools(detail(stale), { success: true }, detail(stale), detail(stale));
  assert.throws(() => reconcileTriggers(def, desired, client), /trigger reconcile failed/);
  assert.equal(client.calls.length, 4);
});

for (const response of [
  undefined,
  null,
  0,
  {},
  { success: true },
  { success: true, data: {} },
  { success: true, data: { apis: null } },
  { success: true, data: { apis: 0 } },
  { success: true, data: { apis: {} } },
  { success: true, data: { raw: { accessList: {} } } },
  { success: true, data: { raw: { accessList: { APISet: null } } } },
  { success: true, data: { routes: [] } },
]) {
  test(`gateway rejects unknown route readback before writing: ${JSON.stringify(response)}`, () => {
    const client = tools(response, { success: true });
    assert.throws(() => ensureGateway(def, client), /getAccess.*(no result object|invalid)/);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.messages, []);
  });
}

for (const api of [null, false, {}, { path: def.routePath }, { Path: '' }, { Path: 0 }]) {
  test(`gateway validates all route entries before returning or writing: ${JSON.stringify(api)}`, () => {
    for (const prefix of [[], [{ Path: def.routePath }]]) {
      const client = tools({ success: true, data: { apis: [...prefix, api] } }, { success: true });
      assert.throws(() => ensureGateway(def, client), /getAccess.*invalid/);
      assert.equal(client.calls.length, 1);
      assert.deepEqual(client.messages, []);
    }
  });
}

for (const response of [
  undefined,
  null,
  0,
  {},
  { success: true },
  { success: true, data: {} },
  { success: true, data: { functionDetail: null } },
  { success: true, data: { functionDetail: {} } },
  { success: true, data: { functionDetail: { FunctionName: def.name } } },
  { success: true, data: { functionDetail: { Triggers: null } } },
  { success: true, data: { functionDetail: { Triggers: 0 } } },
  { success: true, data: { functionDetail: { Triggers: {} } } },
  { success: true, data: { functionDetail: { triggers: [] } } },
  { success: true, data: { triggers: [] } },
  { success: true, data: { functionDetail: { FunctionName: def.name }, triggers: [] } },
]) {
  test(`trigger queries reject unknown lists without writing: ${JSON.stringify(response)}`, () => {
    for (const queryIndex of [0, 1, 2]) {
      const responses = [detail(), detail(), detail()];
      responses[queryIndex] = response;
      const client = tools(...responses);
      assert.throws(
        () => reconcileTriggers(def, [], client),
        /getFunctionDetail.*(no result object|invalid)/,
      );
      assert.equal(client.calls.length, queryIndex + 1);
      assert.ok(client.calls.every(({ args }) => args.action === 'getFunctionDetail'));
      assert.deepEqual(client.messages, []);
    }
  });
}

for (const trigger of [
  null,
  false,
  0,
  {},
  ...['TriggerName', 'Type', 'TriggerDesc'].flatMap((field) =>
    [undefined, null, '', '  ', 0, {}, []].map((value) => timer({ [field]: value })),
  ),
  ...['name', 'type', 'config'].map((field) => ({ ...ALIBABA_SYNC_TIMER, [field]: undefined })),
  { TriggerName: ALIBABA_SYNC_TIMER.name, Kind: 'timer', Schedule: ALIBABA_SYNC_TIMER.config },
]) {
  test(`trigger entries must be complete before any deletion: ${JSON.stringify(trigger)}`, () => {
    for (const wanted of [[], desired]) {
      const stale = timer({ TriggerDesc: '0 * * * * * *' });
      const client = tools(detail([stale, trigger]), { success: true }, detail(), detail());
      assert.throws(() => reconcileTriggers(def, wanted, client), /getFunctionDetail.*invalid/);
      assert.equal(client.calls.length, 1);
      assert.deepEqual(client.messages, []);
    }
  });
}

test('explicit empty trigger arrays are valid and manual-only reconciliation never writes', () => {
  const client = tools(detail(), detail(), detail());
  reconcileTriggers(def, [], client);
  assert.equal(client.calls.length, 3);
  assert.ok(client.calls.every(({ args }) => args.action === 'getFunctionDetail'));
  assert.deepEqual(client.messages, []);
});

test('explicit empty gateway arrays permit creation in both supported readback shapes', () => {
  for (const data of [{ apis: [] }, { raw: { accessList: { APISet: [] } } }]) {
    const client = tools({ success: true, data }, { success: true });
    ensureGateway(def, client);
    assert.deepEqual(
      client.calls.map(({ args }) => args.action),
      ['getAccess', 'createAccess'],
    );
  }
});

test('unknown metadata is ignored only alongside complete known fields', () => {
  const gateway = tools({
    success: true,
    data: { apis: [{ Path: def.routePath, Description: 'metadata' }], RequestId: 'query-id' },
  });
  ensureGateway(def, gateway);
  assert.equal(gateway.calls.length, 1);

  for (const trigger of [timer({ Enable: 1 }), { ...ALIBABA_SYNC_TIMER, Enable: 1 }]) {
    const client = tools(detail([trigger]), detail([trigger]), detail([trigger]));
    reconcileTriggers(def, desired, client);
    assert.ok(client.calls.every(({ args }) => args.action === 'getFunctionDetail'));
  }
});
