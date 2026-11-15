import assert from 'node:assert/strict';
import test from 'node:test';
import { functionManagerFixture, functionZip } from './release-function-manager-fixture.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { sha256 } from './release/input.mjs';
const name = 'alibaba-catalog-sync';
const timer = { name: 'alibaba-sync-tick', type: 'timer', config: '0 */1 * * * * *' };
function setup() {
  const x = functionManagerFixture({ name });
  x.state.detail.Triggers = [
    {
      TriggerName: timer.name,
      Type: timer.type,
      TriggerDesc: JSON.stringify({ cron: timer.config }),
      Enable: 'OPEN',
    },
  ];
  const provider = createCloudbaseFunctionProvider({
    ...x,
    target: { envId: 'fixture-env', siteOrigin: 'https://fixture.example' },
    region: 'ap-shanghai',
    names: [name],
    expectedTriggers: { [name]: [timer] },
  });
  return { ...x, provider };
}
test('a reviewed existing timer stays unchanged during exact code replacement', async () => {
  const x = setup();
  const before = await x.provider.read(name);
  const bytes = functionZip('exports.main=async()=>12;');
  await x.provider.updateCode({
    name,
    runtime: 'Nodejs20.19',
    handler: 'index.main',
    bytes,
    sha256: sha256(bytes),
    expectedSnapshot: before,
  });
  const after = await x.provider.read(name);
  assert.equal(after.configurationToken, before.configurationToken);
  assert.equal(after.packageSha256, sha256(bytes));
  assert.equal(x.state.updates, 1);
  assert.equal(x.state.configUpdates ?? 0, 0);
  assert.equal(x.state.calls.filter((c) => /Trigger/.test(c.action)).length, 0);
});
for (const [label, mutate] of [
  [
    'removed timer',
    (x) => {
      x.state.detail.Triggers = [];
    },
  ],
  [
    'changed cron',
    (x) => {
      x.state.detail.Triggers[0].TriggerDesc = JSON.stringify({ cron: '0 0 * * * * *' });
    },
  ],
  [
    'foreign timer',
    (x) => {
      x.state.detail.Triggers[0].TriggerName = 'other-app';
    },
  ],
  [
    'extra timer',
    (x) => x.state.detail.Triggers.push({ ...x.state.detail.Triggers[0], TriggerName: 'second' }),
  ],
  [
    'malformed description',
    (x) => {
      x.state.detail.Triggers[0].TriggerDesc = 'not-json';
    },
  ],
  [
    'unreviewed VPC',
    (x) => {
      x.state.detail.VpcConfig = { VpcId: 'private', SubnetId: 'private' };
    },
  ],
])
  test(`a timer allowance still rejects ${label}`, async () => {
    const x = setup();
    mutate(x);
    await assert.rejects(x.provider.read(name));
    assert.equal(x.state.updates, 0);
  });
test('timer drift after backup cannot be overwritten', async () => {
  const x = setup();
  const before = await x.provider.read(name);
  x.state.detail.Triggers[0].Enable = 'CLOSE';
  const bytes = functionZip();
  await assert.rejects(
    x.provider.updateCode({
      name,
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      bytes,
      sha256: sha256(bytes),
      expectedSnapshot: before,
    }),
  );
  assert.equal(x.state.updates, 0);
});
