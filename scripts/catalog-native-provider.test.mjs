import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFunctionFixture } from './catalog-native-fixture.mjs';
import { functionManagerFixture } from './release-function-manager-fixture.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { sha256 } from './release/input.mjs';
const name = 'alibaba-catalog-sync';
const bucket = 'fixture-env-1234567890';
function setup(bytes, onStage = () => {}) {
  const x = functionManagerFixture({ name, bytes });
  x.state.nativeObjects = new Map();
  x.state.detail.Triggers = [
    {
      TriggerName: 'alibaba-sync-tick',
      Type: 'timer',
      TriggerDesc: JSON.stringify({ cron: '0 */1 * * * * *' }),
    },
  ];
  const provider = createCloudbaseFunctionProvider({
    ...x,
    target: { envId: 'fixture-env', siteOrigin: 'https://fixture.example' },
    region: 'ap-shanghai',
    names: [name],
    expectedTriggers: {
      [name]: [{ name: 'alibaba-sync-tick', type: 'timer', config: '0 */1 * * * * *' }],
    },
    archiveProfiles: { [name]: 'catalog-native-decoder' },
    archiveBucket: bucket,
    stageArchive: async (data) => {
      const hash = sha256(data);
      x.state.nativeObjects.set(`/seo-recovery/objects/${hash}.bin`, Buffer.from(data));
      onStage(x);
      return {
        fileID: `cloud://fixture-env.${bucket}/seo-recovery/objects/${hash}.bin`,
        bytes: data.length,
        sha256: hash,
      };
    },
  });
  return { ...x, provider };
}
test('the real management SDK receives only a verified environment COS descriptor for the large native ZIP', async () => {
  const fixture = nativeFunctionFixture();
  try {
    const base = fixture.pack();
    const candidate = fixture.pack({ 'index.js': 'exports.main=async()=>({ok:true,revision:2});' });
    const x = setup(base);
    const before = await x.provider.read(name);
    await x.provider.updateCode({
      name,
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      bytes: candidate,
      sha256: sha256(candidate),
      expectedSnapshot: before,
    });
    const call = x.state.calls.find((c) => c.action === 'UpdateFunctionCode');
    assert.deepEqual(call.payload.Code, {
      CosBucketName: 'fixture-env',
      CosBucketRegion: 'ap-shanghai',
      CosObjectName: `/seo-recovery/objects/${sha256(candidate)}.bin`,
    });
    assert.equal(call.payload.InstallDependency, 'FALSE');
    assert.equal(call.payload.Handler, 'index.main');
    assert.equal(Object.hasOwn(call.payload, 'Environment'), false);
    assert.equal((await x.provider.read(name)).packageSha256, sha256(candidate));
    assert.equal(x.state.configUpdates ?? 0, 0);
    const drift = setup(base, (x) => {
      x.state.detail.MemorySize = 512;
    });
    const original = await drift.provider.read(name);
    await assert.rejects(
      drift.provider.updateCode({
        name,
        runtime: 'Nodejs20.19',
        handler: 'index.main',
        bytes: candidate,
        sha256: sha256(candidate),
        expectedSnapshot: original,
      }),
    );
    assert.equal(drift.state.updates, 0);
  } finally {
    fixture.cleanup();
  }
});
