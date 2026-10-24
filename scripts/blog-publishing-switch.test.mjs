import assert from 'node:assert/strict';
import test from 'node:test';
import { setArticlePublishing } from './blog/publishing-switch.mjs';
import { functionManagerFixture } from './release-function-manager-fixture.mjs';
import { sha256 } from './release/input.mjs';
function setup() {
  const f = functionManagerFixture({ name: 'admin' });
  let clock = 0;
  return {
    ...f,
    envId: 'fixture-env',
    expectedVersion: 'A',
    readHealth: async () => 'A',
    readPackageHash: async () => sha256(f.state.bytes),
    now: () => clock,
    pause: async () => {
      clock += 10;
    },
    timeoutMs: 20,
  };
}
test('installed SDK changes only the one switch and preserves every existing environment value', async () => {
  const f = setup();
  const prior = structuredClone(f.state.detail.Environment);
  const result = await setArticlePublishing(f);
  assert.equal(result.status, 'accepted');
  assert.equal(f.state.configUpdates, 1);
  assert.deepEqual(
    f.state.detail.Environment.Variables.filter((v) => v.Key !== 'ARTICLE_PUBLISHING_ENABLED'),
    prior.Variables,
  );
  assert.equal(f.state.detail.MemorySize, 256);
  assert.equal(f.state.updates, 0);
});
test('a lost configuration reply is resolved by readback without repeated writes', async () => {
  const f = setup();
  f.state.fail = 'config-lost-ack';
  assert.equal((await setArticlePublishing(f)).status, 'accepted');
  assert.equal(f.state.configUpdates, 1);
});
test('known enabled but unhealthy switch restores the original complete values once', async () => {
  const f = setup();
  const original = structuredClone(f.state.detail.Environment);
  f.readHealth = async () =>
    f.state.detail.Environment.Variables.some(
      (v) => v.Key === 'ARTICLE_PUBLISHING_ENABLED' && v.Value === '1',
    )
      ? 'bad'
      : 'A';
  assert.equal((await setArticlePublishing(f)).status, 'restored');
  assert.equal(f.state.configUpdates, 2);
  assert.deepEqual(f.state.detail.Environment, original);
});
test('configuration drift stops without overwriting an unrelated change', async () => {
  const f = setup();
  f.state.fail = 'config-drift';
  assert.equal((await setArticlePublishing(f)).status, 'unknown');
  assert.equal(f.state.configUpdates, 1);
});
test('an already enabled switch is idempotent; wrong target or unhealthy initial version cannot write', async () => {
  const f = setup();
  f.state.detail.Environment.Variables.push({ Key: 'ARTICLE_PUBLISHING_ENABLED', Value: '1' });
  assert.equal((await setArticlePublishing(f)).alreadyEnabled, true);
  assert.equal(f.state.configUpdates, undefined);
  await assert.rejects(() => setArticlePublishing({ ...setup(), envId: 'foreign' }));
  await assert.rejects(() => setArticlePublishing({ ...setup(), readHealth: async () => 'wrong' }));
});

test('active configuration is not enough when the actual publication endpoint still reports disabled', async () => {
  const f = setup();
  f.readEnabled = async () => false;
  assert.equal((await setArticlePublishing(f)).status, 'restored');
  assert.equal(f.state.configUpdates, 2);
});
test('publication waits for the real endpoint to reflect a rolling configuration change without another write', async () => {
  const f = setup();
  let reads = 0;
  f.readEnabled = async () => ++reads > 1;
  assert.equal((await setArticlePublishing(f)).status, 'accepted');
  assert.equal(f.state.configUpdates, 1);
  assert(reads >= 3);
});
test('an enabled configuration with an inconsistent endpoint is not reported already enabled', async () => {
  const f = setup();
  f.state.detail.Environment.Variables.push({ Key: 'ARTICLE_PUBLISHING_ENABLED', Value: '1' });
  f.readEnabled = async () => false;
  assert.equal((await setArticlePublishing(f)).status, 'unknown');
  assert.equal(f.state.configUpdates, undefined);
});
