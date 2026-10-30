import assert from 'node:assert/strict';
import test from 'node:test';
import { functionManagerFixture, functionZip } from './release-function-manager-fixture.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { replaceFunctionCode } from './release/function-replacement.mjs';
import { sha256 } from './release/input.mjs';
async function setup(name = 'admin') {
  const f = functionManagerFixture({ name });
  const original = Buffer.from(f.state.bytes);
  const candidate = functionZip('exports.main=async()=>({version:"B"});');
  const provider = createCloudbaseFunctionProvider({
    ...f,
    target: { envId: 'fixture-env', siteOrigin: 'https://fixture.example' },
    region: 'ap-shanghai',
    names: [name],
  });
  const before = await provider.read(name);
  let time = 0;
  return {
    ...f,
    name,
    provider,
    before,
    original,
    candidate,
    beforeVersion: 'A',
    expectedVersion: 'B',
    timeoutMs: 20,
    now: () => time,
    pause: async () => {
      time += 10;
    },
    readHealth: async () => (sha256(f.state.bytes) === sha256(candidate) ? 'B' : 'A'),
  };
}
test('code update preserves configuration and verifies actual package plus running version', async () => {
  const f = await setup();
  const result = await replaceFunctionCode(f);
  assert.equal(result.status, 'accepted');
  assert.equal(f.state.updates, 1);
  assert.equal(result.snapshot.configurationToken, f.before.configurationToken);
});
test('a known activated B with failed health restores exact saved A once', async () => {
  const f = await setup();
  f.readHealth = async () => (sha256(f.state.bytes) === sha256(f.candidate) ? 'unhealthy' : 'A');
  const result = await replaceFunctionCode(f);
  assert.equal(result.status, 'restored');
  assert.deepEqual(f.state.bytes, f.original);
  assert.equal(f.state.updates, 2);
});
test('lost update reply is resolved by actual package and health without repeating the write', async () => {
  const f = await setup();
  f.state.fail = 'lost-ack';
  const result = await replaceFunctionCode(f);
  assert.equal(result.status, 'accepted');
  assert.equal(f.state.updates, 1);
});
for (const failure of ['drift', 'wrong-bytes'])
  test(`unexpected ${failure} stops without restoring over unknown state`, async () => {
    const f = await setup();
    f.state.fail = failure;
    const result = await replaceFunctionCode(f);
    assert.equal(result.status, 'unknown');
    assert.equal(f.state.updates, 1);
  });

test('rerunning acceptance for identical installed code makes no code write', async () => {
  const f = await setup();
  f.candidate = f.original;
  f.expectedVersion = f.beforeVersion;
  f.readHealth = async () => f.beforeVersion;
  const result = await replaceFunctionCode(f);
  assert.equal(result.status, 'accepted');
  assert.equal(result.alreadyInstalled, true);
  assert.equal(f.state.updates, 0);
});
test('the same version label cannot authorize different code', async () => {
  const f = await setup();
  f.expectedVersion = f.beforeVersion;
  await assert.rejects(() => replaceFunctionCode(f), /different program bytes/);
  assert.equal(f.state.updates, 0);
});

test('the public API uses the same code-only update and exact restoration checks', async () => {
  const f = await setup('public-api');
  const result = await replaceFunctionCode(f);
  assert.equal(result.status, 'accepted');
  assert.equal(result.snapshot.name, 'public-api');
  assert.equal(result.snapshot.configurationToken, f.before.configurationToken);
});
test('Blog expansion cannot update another function', async () => {
  const f = await setup('admin');
  await assert.rejects(
    replaceFunctionCode({ ...f, name: 'alibaba-catalog-sync' }),
    /verified original/,
  );
  assert.equal(f.state.updates, 0);
});
