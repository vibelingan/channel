import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostingObjectReader } from './release/hosting-object-reader.mjs';
function fixture() {
  const config = {
    envId: 'fixture-env',
    secretId: 'fixture-id',
    secretKey: 'fixture-key',
    token: 'fixture-token',
  };
  const environment = {
    getEnvId: () => 'fixture-env',
    lazyInit: async () => {},
    getHostingService: () => ({
      getInfo: async () => [
        {
          Status: 'online',
          Bucket: 'fixture-123',
          Regoin: 'ap-shanghai',
          ExternalStorage: { Enabled: true, BasePath: '/shared/env/' },
        },
      ],
    }),
  };
  return {
    target: { envId: 'fixture-env' },
    manager: {
      getManagerConfig: () => config,
      currentEnvironment: () => environment,
    },
    environment,
  };
}
test('backup origin uses installed COS signer and exact hosting shared-prefix key with bounded HTTP options', async () => {
  const f = fixture();
  let calls = 0;
  const reader = await createHostingObjectReader({
    ...f,
    request: async (method, address, options) => {
      calls++;
      const url = new URL(address);
      assert.equal(method, 'GET');
      assert.equal(url.origin, 'https://fixture-123.cos.ap-shanghai.tencentcos.cn');
      assert.equal(decodeURIComponent(url.pathname), '/shared/env/media/中.png');
      assert(url.searchParams.has('q-signature'));
      assert.equal(url.searchParams.get('x-cos-security-token'), 'fixture-token');
      assert.equal(options.maxBytes, 9);
      assert.equal(options.timeoutMs, 60000);
      assert.equal(options.redirect, 'error');
      return { status: 200, body: Buffer.from('complete'), headers: new Headers() };
    },
  });
  const result = await reader('GET', 'https://fixture.invalid/media/%E4%B8%AD.png', {
    maxBytes: 9,
    timeoutMs: 60000,
  });
  assert.equal(calls, 1);
  assert.equal(result.body.toString(), 'complete');
  await assert.rejects(reader('PUT', 'https://fixture.invalid/index.html', {}), /read-only/);
});
test('signed URL and temporary credentials are not retained in network errors', async () => {
  const reader = await createHostingObjectReader({
    ...fixture(),
    request: async (_method, address) => {
      throw Error(`GET ${address} timed out`);
    },
  });
  await assert.rejects(reader('GET', 'https://fixture.invalid/index.html', {}), (e) => {
    assert.equal(e.code, 'ETIMEDOUT');
    assert.doesNotMatch(
      JSON.stringify(e) + e.stack,
      /fixture-token|q-signature|fixture-key|fixture-id/,
    );
    assert.equal(e.cause, undefined);
    return true;
  });
});
test('foreign environment and a changed environment are rejected before reading an object', async () => {
  const f = fixture();
  await assert.rejects(createHostingObjectReader({ ...f, target: { envId: 'other' } }), /differs/);
  const reader = await createHostingObjectReader(f);
  f.manager.getManagerConfig().envId = 'other';
  await assert.rejects(reader('GET', 'https://fixture.invalid/index.html', {}), /differs/);
});
test('untrusted bucket or region metadata is rejected before network access', async () => {
  const f = fixture();
  f.environment.getHostingService = () => ({
    getInfo: async () => [{ Status: 'online', Bucket: 'bad.bucket', Regoin: 'ap-shanghai' }],
  });
  await assert.rejects(createHostingObjectReader(f), /metadata/);
});

test('the installed Manager resolves the hosting bucket separately from ordinary cloud storage', async () => {
  const { managerFixture } = await import('./release-manager-fixture.mjs');
  const { target } = await import('./release-hosting-fixtures.mjs');
  const f = managerFixture();
  f.state.store.Bucket = 'fixture-123';
  f.manager.getManagerConfig().secretId = 'fixture-id';
  f.manager.getManagerConfig().secretKey = 'fixture-key';
  let calls = 0;
  const reader = await createHostingObjectReader({
    manager: f.manager,
    target,
    request: async (_method, address) => {
      calls++;
      assert.equal(new URL(address).hostname, 'fixture-123.cos.ap-shanghai.tencentcos.cn');
      return { status: 200, body: Buffer.from('complete'), headers: new Headers() };
    },
  });
  await reader('GET', 'https://fixture.invalid/index.html', {});
  assert.equal(calls, 1);
  assert(f.state.calls.some((c) => c.action === 'DescribeStaticStore'));
  assert.equal(f.state.uploads, 0);
  assert.equal(f.state.deleted, 0);
});

test('shared hosting bucket fields fall back only when external storage is enabled', async () => {
  const f = fixture();
  f.environment.getHostingService = () => ({
    getInfo: async () => [
      {
        Status: 'online',
        Bucket: '',
        Regoin: '',
        ExternalStorage: {
          Enabled: true,
          BucketName: 'shared-123',
          Region: 'ap-shanghai',
          BasePath: '/envs/fixture/',
        },
      },
    ],
  });
  const reader = await createHostingObjectReader({
    ...f,
    request: async (_method, address) => {
      const url = new URL(address);
      assert.equal(url.hostname, 'shared-123.cos.ap-shanghai.tencentcos.cn');
      assert.equal(url.pathname, '/envs/fixture/index.html');
      return { status: 200, body: Buffer.from('complete'), headers: new Headers() };
    },
  });
  await reader('GET', 'https://fixture.invalid/index.html', {});
  f.environment.getHostingService = () => ({
    getInfo: async () => [
      {
        Status: 'online',
        Bucket: '',
        Regoin: '',
        ExternalStorage: { Enabled: false, BucketName: 'shared-123', Region: 'ap-shanghai' },
      },
    ],
  });
  await assert.rejects(createHostingObjectReader(f), /metadata/);
});

test('backup reader uses public Manager config and snapshots signing credentials', async () => {
  const f = fixture();
  Object.defineProperty(f.manager, 'cloudBaseConfig', {
    get() {
      throw Error('Private SDK configuration was accessed');
    },
  });
  const reader = await createHostingObjectReader({
    ...f,
    request: async (_method, address) => {
      assert.equal(new URL(address).searchParams.get('q-ak'), 'fixture-id');
      return { status: 200, body: Buffer.from('complete'), headers: new Headers() };
    },
  });
  f.manager.getManagerConfig().secretId = 'changed-by-caller';
  await reader('GET', 'https://fixture.invalid/index.html', {});
});

test('missing signing credentials fail before metadata or HTTP requests', async () => {
  const f = fixture();
  f.manager.getManagerConfig().secretKey = '';
  let reads = 0;
  f.environment.getHostingService = () => {
    reads++;
    throw Error('Unexpected metadata read');
  };
  await assert.rejects(createHostingObjectReader(f), /Explicit backup credentials/);
  assert.equal(reads, 0);
});
