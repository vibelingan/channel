import assert from 'node:assert/strict';
import test from 'node:test';
import { setBlogFunctionSwitch } from './blog/publishing-switch.mjs';
import { functionManagerFixture } from './release-function-manager-fixture.mjs';
import { sha256 } from './release/input.mjs';
function setup(name, key, value) {
  const f = functionManagerFixture({ name });
  let clock = 0;
  return {
    ...f,
    name,
    key,
    value,
    envId: 'fixture-env',
    expectedVersion: 'A',
    readHealth: async () => 'A',
    readPackageHash: async () => sha256(f.state.bytes),
    readAppliedValue: async () =>
      f.state.detail.Environment.Variables.find((v) => v.Key === key)?.Value ??
      (key === 'ARTICLE_DELIVERY_MODE' ? 'static' : '0'),
    now: () => clock,
    pause: async () => {
      clock += 10;
    },
    timeoutMs: 20,
  };
}
test('real SDK sets each exact Blog switch, independently preserves all other configuration and reads the running value', async () => {
  for (const [name, key, value] of [
    ['admin', 'ARTICLE_DELIVERY_MODE', 'server'],
    ['admin', 'ARTICLE_PUBLISHING_ENABLED', '0'],
    ['public-api', 'ARTICLE_PUBLIC_READ_ENABLED', '1'],
  ]) {
    const f = setup(name, key, value);
    const original = structuredClone(f.state.detail.Environment.Variables);
    assert.equal((await setBlogFunctionSwitch(f)).status, 'accepted');
    assert.equal(f.state.configUpdates, 1);
    assert.deepEqual(
      f.state.detail.Environment.Variables.filter((v) => v.Key !== key),
      original,
    );
    assert.equal((await setBlogFunctionSwitch(f)).alreadyApplied, true);
    assert.equal(f.state.configUpdates, 1);
    assert.equal(f.state.updates, 0);
  }
});
test('mode readback that never reaches the running program restores prior configuration once', async () => {
  const f = setup('admin', 'ARTICLE_DELIVERY_MODE', 'server');
  const original = structuredClone(f.state.detail.Environment);
  f.readAppliedValue = async () => 'static';
  assert.equal((await setBlogFunctionSwitch(f)).status, 'restored');
  assert.equal(f.state.configUpdates, 2);
  assert.deepEqual(f.state.detail.Environment, original);
});
test('another function, key, unsupported value or legacy static selection is refused without writes', async () => {
  for (const [name, key, value] of [
    ['alibaba-catalog-sync', 'ARTICLE_DELIVERY_MODE', 'server'],
    ['admin', 'JWT_SECRET', 'changed'],
    ['public-api', 'ARTICLE_DELIVERY_MODE', 'server'],
    ['admin', 'ARTICLE_DELIVERY_MODE', 'static'],
    ['public-api', 'ARTICLE_PUBLIC_READ_ENABLED', 'true'],
  ]) {
    const f = setup(name, key, value);
    await assert.rejects(setBlogFunctionSwitch(f), /Unplanned/);
    assert.equal(f.state.configUpdates, undefined);
    assert.equal(f.state.updates, 0);
  }
});
