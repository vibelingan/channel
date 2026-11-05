import assert from 'node:assert/strict';
import test from 'node:test';
import { functionManagerFixture } from './release-function-manager-fixture.mjs';
import { setCatalogRuntimeFlags } from './release/catalog-runtime-config.mjs';
const target = {
  envId: 'fixture-env',
  region: 'ap-shanghai',
  siteOrigin: 'https://fixture.example',
};
async function fixture(name = 'admin') {
  const x = functionManagerFixture({ name });
  x.state.detail.Environment.Variables.push(
    { Key: 'TCB_ENV', Value: target.envId },
    { Key: 'CATALOG_DETAIL_APPROVAL_ENABLED', Value: '1' },
  );
  const before = await x.manager.functions.getFunctionDetail(name);
  return { ...x, target, name, before, phase: 'record', wait: async () => {} };
}
test('recording changes only its three settings and preserves every existing secret', async () => {
  const x = await fixture();
  const result = await setCatalogRuntimeFlags(x);
  assert.equal(result.name, 'admin');
  assert.equal(result.phase, 'record');
  const env = Object.fromEntries(x.state.detail.Environment.Variables.map((v) => [v.Key, v.Value]));
  assert.equal(env.JWT_SECRET, 'sdk-fixture-secret');
  assert.equal(env.TCB_ENV, target.envId);
  assert.equal(env.CATALOG_SEO_RECORDING, '1');
  assert.equal(env.CATALOG_SEO_SITE_ORIGIN, target.siteOrigin);
  assert.equal(env.CATALOG_DETAIL_APPROVAL_ENABLED, '1');
  assert.equal(x.state.configUpdates, 1);
  assert.equal(x.state.updates, 0);
  assert.equal(JSON.stringify(result).includes('sdk-fixture-secret'), false);
});
test('an accepted repeated setting does not issue a second write', async () => {
  const x = await fixture();
  await setCatalogRuntimeFlags(x);
  x.before = await x.manager.functions.getFunctionDetail(x.name);
  await setCatalogRuntimeFlags(x);
  assert.equal(x.state.configUpdates, 1);
});
test('a lost reply is settled by exact readback without another mutation', async () => {
  const x = await fixture();
  x.state.fail = 'config-lost-ack';
  await setCatalogRuntimeFlags(x);
  assert.equal(x.state.configUpdates, 1);
});
test('configuration drift is never accepted', async () => {
  const x = await fixture();
  x.state.fail = 'config-drift';
  await assert.rejects(setCatalogRuntimeFlags(x));
  assert.equal(x.state.configUpdates, 1);
});
test('foreign function, masked read, and drift before submission refuse writes', async () => {
  for (const mutate of [
    (x) => {
      x.name = 'other-app';
    },
    (x) => {
      x.before.Environment.Variables[0].Value = '***';
    },
    (x) => {
      x.state.detail.MemorySize = 512;
    },
  ]) {
    const x = await fixture();
    mutate(x);
    await assert.rejects(setCatalogRuntimeFlags(x));
    assert.equal(x.state.configUpdates ?? 0, 0);
  }
});
test('public page readiness has a separate setting and does not enable writer recording', async () => {
  const x = await fixture('public-api');
  x.phase = 'readiness';
  await setCatalogRuntimeFlags(x);
  const env = Object.fromEntries(x.state.detail.Environment.Variables.map((v) => [v.Key, v.Value]));
  assert.equal(env.CATALOG_SEO_PAGE_READINESS, '1');
  assert.equal(env.CATALOG_SEO_RECORDING, undefined);
});
test('server variable ordering does not change the requested meaning', async () => {
  const x = await fixture();
  const read = x.manager.functions.getFunctionDetail.bind(x.manager.functions);
  x.manager.functions.getFunctionDetail = async (...args) => {
    const d = await read(...args);
    if (x.state.configUpdates) d.Environment.Variables.reverse();
    return d;
  };
  await setCatalogRuntimeFlags(x);
  assert.equal(x.state.configUpdates, 1);
});
