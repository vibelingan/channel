import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibilityFixture } from './release-function-fixtures.mjs';
import { functionManagerFixture } from './release-function-manager-fixture.mjs';
import {
  createCloudbaseContractReader,
  createFunctionObserver,
} from './release/function-observation.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { identity } from './release/input.mjs';
function setup() {
  const x = compatibilityFixture();
  const sdk = functionManagerFixture();
  const policy = {
    repository: 'fixture/channel',
    ...x.target,
    functions: ['public-api'],
    writerInventorySha256: 'a'.repeat(64),
    clientInventorySha256: 'b'.repeat(64),
  };
  const provider = createCloudbaseFunctionProvider({
    ...sdk,
    target: x.target,
    region: 'ap-shanghai',
    names: policy.functions,
    configurationKey: Buffer.alloc(32, 1),
  });
  let record = {
    schemaVersion: 1,
    purpose: 'function-recovery-contract-state',
    target: x.target,
    revision: 'state-r1',
    data: x.observation.data,
    writers: {
      coverage: 'all',
      inventorySha256: policy.writerInventorySha256,
      functions: [{ name: 'public-api', codeShas: ['a'.repeat(40), 'b'.repeat(40)] }],
    },
    clients: {
      coverage: 'all-exposed',
      inventorySha256: policy.clientInventorySha256,
      revision: 'clients-r1',
      contracts: x.observation.exposedClientContracts,
    },
  };
  let reads = 0;
  let healthChange;
  const observer = createFunctionObserver({
    policy,
    provider,
    clock: () => x.now,
    readContractState: async () => {
      reads++;
      return structuredClone(record);
    },
    readHealth: async (name) => {
      healthChange?.();
      return { status: 'healthy', name, codeSha: 'b'.repeat(40), target: x.target };
    },
  });
  return {
    x,
    sdk,
    policy,
    provider,
    observer,
    get record() {
      return record;
    },
    set record(value) {
      record = value;
    },
    get reads() {
      return reads;
    },
    healthChange(fn) {
      healthChange = fn;
    },
  };
}
test('live observation binds actual SDK ZIP, health release and keyed configuration references', async () => {
  const f = setup();
  const r = await f.observer.inspect();
  assert.equal(r.status, 'ready');
  assert.equal(r.observation.functions[0].codeSha, 'b'.repeat(40));
  assert.equal(r.functions[0].configuration.references[0].name, 'JWT_SECRET');
  assert.match(r.functions[0].configuration.references[0].version, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(r).includes('sdk-fixture-secret'));
  assert(!JSON.stringify(r).includes('fixture-private-signature'));
  assert.equal(f.sdk.state.updates, 0);
  assert.equal(f.reads, 2);
});
for (const [label, mutate] of [
  [
    'missing',
    (f) => {
      f.record = null;
    },
  ],
  [
    'unreviewed inventory',
    (f) => {
      f.policy.writerInventorySha256 = null;
    },
  ],
  [
    'incomplete coverage',
    (f) => {
      f.record.writers.coverage = 'partial';
    },
  ],
  [
    'new writer',
    (f) => {
      f.record.writers.functions[0].codeShas = ['c'.repeat(40)];
    },
  ],
  [
    'missing clients',
    (f) => {
      f.record.clients.contracts = [];
    },
  ],
])
  test(`production ${label} never produces a usable observation`, async () => {
    const f = setup();
    mutate(f);
    assert.equal((await f.observer.inspect()).status, 'manual-required');
    await assert.rejects(f.observer.observe());
    assert.equal(f.sdk.state.updates, 0);
  });
test('function or configuration drift between package and health reads is rejected', async () => {
  const f = setup();
  f.healthChange(() => {
    f.sdk.state.detail.Environment.Variables[0].Value = 'changed';
  });
  await assert.rejects(f.observer.inspect(), /changed/);
});
test('stable configuration key survives a new process instance and key rotation invalidates identity', async () => {
  const f = setup();
  const first = await f.provider.read('public-api');
  const same = createCloudbaseFunctionProvider({
    ...f.sdk,
    target: f.x.target,
    region: 'ap-shanghai',
    names: ['public-api'],
    configurationKey: Buffer.alloc(32, 1),
  });
  const changed = createCloudbaseFunctionProvider({
    ...f.sdk,
    target: f.x.target,
    region: 'ap-shanghai',
    names: ['public-api'],
    configurationKey: Buffer.alloc(32, 2),
  });
  assert.equal((await same.read('public-api')).configurationToken, first.configurationToken);
  assert.notEqual((await changed.read('public-api')).configurationToken, first.configurationToken);
  assert.throws(() =>
    createCloudbaseFunctionProvider({
      ...f.sdk,
      target: f.x.target,
      region: 'ap-shanghai',
      names: ['public-api'],
      configurationKey: Buffer.alloc(8),
    }),
  );
});
test('contract reader uses direct SDK document arrays, a fixed server-only collection and no mutation method', async () => {
  const policy = {
    repository: 'fixture/channel',
    envId: 'fixture-env',
    siteOrigin: 'https://fixture.example',
  };
  let value = [];
  let selected;
  const db = {
    config: { env: policy.envId },
    collection(name) {
      assert.equal(name, 'siteReleaseTargets');
      return {
        doc(id) {
          selected = id;
          return { get: async () => ({ data: value }) };
        },
      };
    },
  };
  const reader = createCloudbaseContractReader({ db, policy });
  assert.equal(await reader.read(), null);
  assert.equal(selected, reader.documentId);
  value = [{ _id: reader.documentId, revision: 'r1' }];
  assert.deepEqual(await reader.read(), { revision: 'r1' });
  for (const invalid of [null, {}, [{}, {}], [{ _id: 'foreign' }]]) {
    value = invalid;
    await assert.rejects(reader.read());
  }
  assert.throws(() =>
    createCloudbaseContractReader({ db: { config: { env: 'foreign' } }, policy }),
  );
  assert.match(reader.documentId, /^compatibility-[a-f0-9]{64}$/);
});
test('contract revision changed during observation blocks a plan', async () => {
  const f = setup();
  const observer = createFunctionObserver({
    policy: f.policy,
    provider: f.provider,
    clock: () => f.x.now,
    readContractState: async () => {
      const value = structuredClone(f.record);
      f.record.revision = 'new';
      return value;
    },
    readHealth: async (name) => ({
      status: 'healthy',
      name,
      codeSha: 'b'.repeat(40),
      target: f.x.target,
    }),
  });
  assert((await observer.inspect()).reasons.includes('CONTRACT_STATE_CHANGED_DURING_READ'));
});
