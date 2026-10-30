import assert from 'node:assert/strict';
import test from 'node:test';
import { deployCatalogClock, readClockHealth } from './release/catalog-clock-deploy.mjs';
const sha = 'a'.repeat(40);
function fixture(existing = false) {
  let detail = existing
    ? {
        FunctionName: 'catalog-seo-clock',
        Description: 'channel-catalog-seo-clock-v1',
        Runtime: 'Nodejs20.19',
        Handler: 'index.main',
        Type: 'Event',
        Status: 'Active',
        AvailableStatus: 'Available',
        Triggers: [],
        Environment: { Variables: [{ Key: 'UNMANAGED_SETTING', Value: 'keep' }] },
      }
    : null;
  const writes = [];
  const update = (func) => {
    detail = {
      ...detail,
      FunctionName: func.name,
      Description: func.description ?? detail?.Description,
      Runtime: func.runtime ?? detail?.Runtime,
      Handler: func.handler ?? detail?.Handler,
      Type: func.type ?? detail?.Type,
      Status: 'Active',
      AvailableStatus: 'Available',
      Triggers: detail?.Triggers ?? [],
      Environment: {
        Variables: Object.entries(func.envVariables).map(([Key, Value]) => ({ Key, Value })),
      },
    };
  };
  const functions = {
    listFunctions: async () => (detail ? [detail] : []),
    getFunctionDetail: async () => detail,
    createFunction: async ({ func }) => {
      writes.push('create');
      update(func);
    },
    updateFunctionConfig: async (func) => {
      writes.push('config');
      update(func);
    },
    updateFunctionCode: async () => writes.push('code'),
    invokeFunction: async () => ({
      RequestId: 'id',
      RetMsg: JSON.stringify({ service: 'catalog-seo-clock', codeSha: sha, enabled: false }),
    }),
    getFunctionDownloadUrl: async () => ({ CodeSha256: 'actual-cloud-package-hash' }),
    createFunctionTriggers: async () => {
      writes.push('trigger');
      detail.Triggers = [
        { TriggerName: 'catalog-seo-minute', Type: 'timer', TriggerDesc: '0 * * * * * *' },
      ];
    },
  };
  return {
    manager: { functions },
    action: 'stage',
    directory: '/owned/bundle',
    codeSha: sha,
    wait: async () => {},
    writes,
    detail: () => detail,
  };
}
test('stage creates only its own private function with notification switched off', async () => {
  const x = fixture();
  const r = await deployCatalogClock(x);
  assert.deepEqual(x.writes, ['create']);
  assert.equal(r.enabled, false);
  assert.equal(r.websiteWrites, 0);
  assert.equal(
    x.detail().Environment.Variables.find((v) => v.Key === 'CATALOG_SEO_CLOCK_ENABLED').Value,
    '0',
  );
});
test('an update preserves unrelated function settings and does not create a second timer', async () => {
  const x = fixture(true);
  await deployCatalogClock(x);
  assert.deepEqual(x.writes, ['config', 'code']);
  assert.equal(
    x.detail().Environment.Variables.find((v) => v.Key === 'UNMANAGED_SETTING').Value,
    'keep',
  );
});
test('name collision refuses all writes', async () => {
  const x = fixture(true);
  x.detail().Description = 'another-app';
  await assert.rejects(deployCatalogClock(x), /another owner/);
  assert.equal(x.writes.length, 0);
});
test('enable requires accepted HTML and a service credential', async () => {
  const x = fixture(true);
  x.action = 'enable';
  await assert.rejects(deployCatalogClock(x), /Accepted HTML/);
  assert.equal(x.writes.length, 0);
});
test('stop preserves other settings and never touches code or triggers', async () => {
  const x = fixture(true);
  x.action = 'disable';
  const r = await deployCatalogClock(x);
  assert.equal(r.enabled, false);
  assert.deepEqual(x.writes, ['config']);
  assert.equal(
    x.detail().Environment.Variables.find((v) => v.Key === 'UNMANAGED_SETTING').Value,
    'keep',
  );
});
test('incomplete, failed, or wrong-source SDK health replies cannot be accepted', () => {
  const response = {
    RequestId: 'id',
    RetMsg: JSON.stringify({ service: 'catalog-seo-clock', codeSha: sha, enabled: false }),
  };
  assert.equal(readClockHealth(response, sha, false).codeSha, sha);
  for (const bad of [
    { ...response, InvokeFinished: 0 },
    { ...response, RetCode: 1 },
    { ...response, RequestId: '' },
    { ...response, ErrMsg: 'failed' },
    { ...response, RetMsg: 'null' },
    { ...response, RetMsg: '{' },
    {
      ...response,
      RetMsg: JSON.stringify({
        service: 'catalog-seo-clock',
        codeSha: 'b'.repeat(40),
        enabled: false,
      }),
    },
  ])
    assert.throws(() => readClockHealth(bad, sha, false));
});

test('enable reads back the existing program, preserves unrelated settings and creates exactly its reviewed timer', async () => {
  const x = fixture(true);
  x.action = 'enable';
  x.accepted = { verified: true, rendererSha: sha };
  x.credentials = { appId: 1, installationId: 2, privateKey: 'fixture PRIVATE KEY' };
  const r = await deployCatalogClock(x);
  assert.equal(r.enabled, true);
  assert.deepEqual(x.writes, ['trigger', 'config']);
  assert.equal(
    x.detail().Environment.Variables.find((v) => v.Key === 'UNMANAGED_SETTING').Value,
    'keep',
  );
});
test('an unknown creation result is never retried or deleted', async () => {
  const x = fixture();
  let calls = 0;
  x.manager.functions.createFunction = async () => {
    calls++;
    throw Error('lost creation reply');
  };
  await assert.rejects(deployCatalogClock(x), /lost creation/);
  assert.equal(calls, 1);
  assert.equal(x.writes.length, 0);
});
test('a different existing timer blocks activation before cloud writes', async () => {
  const x = fixture(true);
  x.action = 'enable';
  x.accepted = { verified: true, rendererSha: sha };
  x.credentials = { appId: 1, installationId: 2, privateKey: 'fixture PRIVATE KEY' };
  x.detail().Triggers = [
    { TriggerName: 'another-task', Type: 'timer', TriggerDesc: '0 0 * * * * *' },
  ];
  await assert.rejects(deployCatalogClock(x), /configuration differs/);
  assert.equal(x.writes.length, 0);
});
