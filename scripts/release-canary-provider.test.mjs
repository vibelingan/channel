import assert from 'node:assert/strict';
import test from 'node:test';
import { managerFixture } from './release-manager-fixture.mjs';
import { policy } from './release-state-fixtures.mjs';
import { createCanaryProvider } from './release/canary-provider.mjs';
import { tables } from './release/ledger.mjs';

test('installed Manager findFiles uses only the pinned prefix and rejects incomplete or occupied ownership', async () => {
  const f = managerFixture();
  const storage = f.manager.currentEnvironment().getStorageService();
  let observed;
  storage.getCos = () => ({
    getBucket(options, cb) {
      observed = options;
      cb(null, { Prefix: options.Prefix, IsTruncated: 'false', Contents: [] });
    },
  });
  const provider = createCanaryProvider({ manager: f.manager, policy });
  assert.deepEqual(await provider.inventory(policy.canaryPrefix), []);
  assert.equal(observed.Prefix, policy.canaryPrefix);
  assert.equal(observed.MaxKeys, 2);
  await assert.rejects(provider.inventory('products/'), /prefix/);
  storage.getCos = () => ({
    getBucket(options, cb) {
      cb(null, { Prefix: options.Prefix, IsTruncated: 'true', Contents: [] });
    },
  });
  await assert.rejects(provider.inventory(policy.canaryPrefix), /inventory/);
});
test('control plane must preexist and permissions plus OPA require an exact reviewed fingerprint', async () => {
  const calls = [];
  const f = managerFixture({
    request: async (args) => {
      calls.push(args);
      if (args.action === 'DescribeTable') return { TableName: args.payload.TableName };
      if (args.action === 'DescribeResourcePermission')
        return {
          Data: {
            TotalCount: 4,
            PermissionList: Object.values(tables).map((Resource) => ({
              Resource,
              Permission: 'ADMINONLY',
            })),
          },
        };
      if (args.action === 'DescribeEnvConfig')
        return { Item: { Key: args.payload.Key, Value: '' } };
      return undefined;
    },
  });
  const provider = createCanaryProvider({ manager: f.manager, policy });
  const result = await provider.controlPlane();
  assert.match(result.securityReviewSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(provider.controlPlane({ execute: true }), /review/);
  const reviewed = createCanaryProvider({
    manager: f.manager,
    policy: { ...policy, controlPlaneReviewSha256: result.securityReviewSha256 },
  });
  assert.equal(
    (await reviewed.controlPlane({ execute: true })).securityReviewSha256,
    result.securityReviewSha256,
  );
  assert.ok(
    calls.some(
      (c) => c.action === 'DescribeResourcePermission' && c.payload.EnvId === policy.envId,
    ),
  );
  assert.ok(calls.every((c) => !/^Create|^Modify|^Delete/.test(c.action)));
});

test('missing collections and unreadable authorization never trigger provisioning or cloud writes', async () => {
  const f = managerFixture();
  const provider = createCanaryProvider({ manager: f.manager, policy });
  await assert.rejects(provider.controlPlane(), /separate reviewed provisioning/);
  assert.ok(!f.state.calls.some((x) => /^Create|^Modify|^Delete/.test(x.action)));
});

test('live DescribeEnvConfig Item response supports an absent OPA policy and rejects ambiguous records', async () => {
  let item = { Key: '', Value: '' };
  const fixture = managerFixture({
    request: async ({ action }) => {
      if (action === 'DescribeTable') return { RequestId: 'read-table' };
      if (action === 'DescribeResourcePermission')
        return {
          Data: {
            TotalCount: 4,
            PermissionList: Object.values(tables).map((Resource) => ({
              Resource,
              Permission: 'ADMINONLY',
            })),
          },
        };
      if (action === 'DescribeEnvConfig') return { Item: item, RequestId: 'live-shape' };
    },
  });
  const provider = createCanaryProvider({ manager: fixture.manager, policy });
  assert.match((await provider.controlPlane()).securityReviewSha256, /^[a-f0-9]{64}$/);
  for (const malformed of [
    { Key: '', Value: 'nonempty policy without identity' },
    { Key: 'other', Value: '' },
    { Key: '', Value: null },
  ]) {
    item = malformed;
    await assert.rejects(provider.controlPlane(), /authorization configuration/);
  }
});
