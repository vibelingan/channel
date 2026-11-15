import assert from 'node:assert/strict';
import test from 'node:test';
import { domainConfiguration, target } from './release-hosting-fixtures.mjs';
import { managerFixture } from './release-manager-fixture.mjs';
import {
  configurationHash,
  configurationStateHash,
  inverseHostingConfiguration,
  prepareHostingConfiguration,
} from './release/hosting-configuration.mjs';
import { createCloudbaseHostingProvider } from './release/hosting-provider.mjs';

test('installed Manager SDK is bound to explicit env and performs single-object upload and exact delete', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  const port = createCloudbaseHostingProvider({ manager, target });
  assert.equal(
    configurationHash(await port.readConfiguration()),
    configurationHash(state.configuration),
  );
  const result = await port.upload('canary/a.html', Buffer.from('hello'));
  assert.equal(result.terminal, true);
  assert.equal(state.files.get('canary/a.html').toString(), 'hello');
  assert.equal(result.providerOperationId, 'put-file');
  await port.remove('canary/a.html');
  assert.equal(state.files.has('canary/a.html'), false);
  assert.equal(state.deleted, 1);
  assert.equal(
    state.calls.find((c) => c.action === 'DescribeHTTPServiceRoute').payload.EnvId,
    target.envId,
  );
});
test('explicit env mismatch is rejected before SDK resources are read', () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  assert.throws(() =>
    createCloudbaseHostingProvider({ manager, target: { ...target, envId: 'wrong-env' } }),
  );
  assert.equal(state.calls.length, 0);
});
test('domain header patch uses the installed SDK and preserves all routes and certificate', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  const port = createCloudbaseHostingProvider({ manager, target });
  const before = await port.readConfiguration();
  const plan = prepareHostingConfiguration({
    target,
    before,
    previousCacheControl: 'no-store',
    cacheControl: 'no-cache',
  });
  await port.configure(plan.changes[0]);
  assert.equal(
    configurationStateHash(await port.readConfiguration()),
    configurationStateHash(plan.after),
  );
  const request = state.calls.find((c) => c.action === 'ModifyHTTPServiceRoute');
  assert.deepEqual(Object.keys(request.payload).sort(), ['Domain', 'EnvId']);
  assert.deepEqual(Object.keys(request.payload.Domain).sort(), ['Domain', 'Extension']);
  assert.equal(state.configuration.gateway.Domains[0].CertId, 'preserved-cert');
});
test('website SDK roundtrip preserves supported flags and conditional source check', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  state.configuration.website.WebsiteConfiguration.ErrorDocument = {
    Key: 'old-error.html',
    OriginalHttpStatus: 'Enabled',
    Charity404: 'Disabled',
  };
  const port = createCloudbaseHostingProvider({ manager, target });
  const before = await port.readConfiguration();
  const plan = prepareHostingConfiguration({
    target,
    before,
    errorDocument: 'errors/not-found.html',
  });
  await port.configure(plan.changes[0]);
  assert.equal(
    configurationStateHash(await port.readConfiguration()),
    configurationStateHash(plan.after),
  );
  await assert.rejects(port.configure(plan.changes[0]));
  assert.equal(state.calls.filter((c) => c.action === 'cos-website').length, 1);
});
for (const failure of ['delete', 'configure', 'missing-request-id'])
  test(`provider rejects ${failure} instead of claiming success`, async () => {
    const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
    const port = createCloudbaseHostingProvider({ manager, target });
    const before = await port.readConfiguration();
    const plan = prepareHostingConfiguration({
      target,
      before,
      previousCacheControl: 'no-store',
      cacheControl: 'no-cache',
    });
    state.fail = failure;
    await assert.rejects(
      failure === 'delete' ? port.remove('owned.html') : port.configure(plan.changes[0]),
      (error) => !error.message.includes('secret credential'),
    );
  });

test('staging preserves the filename extension used by COS MIME inference', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  const port = createCloudbaseHostingProvider({ manager, target });
  await port.upload('assets/app.hash.js', Buffer.from('script'));
  assert.ok(state.lastFilePath.endsWith('/app.hash.js'));
});
test('a site batch is one installed-SDK upload with one COS client and an exact completion per file', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  const port = createCloudbaseHostingProvider({ manager, target });
  const files = [
    { path: 'index.html', body: Buffer.from('home') },
    { path: 'blog/index.html', body: Buffer.from('blog') },
    { path: 'products/p-one/index.html', body: Buffer.from('one') },
  ];
  const result = await port.uploadBatch(files, { parallel: 3 });
  assert.equal(result.terminal, true);
  assert.deepEqual(result.files, [
    { path: 'index.html', providerOperationId: 'put-file' },
    { path: 'blog/index.html', providerOperationId: 'put-file' },
    { path: 'products/p-one/index.html', providerOperationId: 'put-file' },
  ]);
  for (const file of files)
    assert.equal(state.files.get(file.path).toString(), file.body.toString());
  assert.equal(state.uploads, 1);
  assert.deepEqual(state.cosClients, [{ parallel: 3 }]);
  assert.equal(state.calls.filter((c) => c.action === 'DescribeStaticStore').length, 1);
  assert.ok(state.lastFilePath.endsWith('/index.html'));
});
test('one missing file completion leaves the whole SDK batch unconfirmed', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  const port = createCloudbaseHostingProvider({ manager, target });
  state.missingAck = new Set(['b.html']);
  await assert.rejects(
    port.uploadBatch(
      [
        { path: 'a.html', body: Buffer.from('a') },
        { path: 'b.html', body: Buffer.from('b') },
      ],
      { parallel: 2 },
    ),
    /unconfirmed/,
  );
  assert.equal(state.uploads, 1);
});
test('a batch whose parallel upload fails is confirmed only by the SDK serial fallback per file', async () => {
  const { manager, state } = managerFixture();
  const port = createCloudbaseHostingProvider({ manager, target });
  state.fail = 'parallel-fallback';
  const result = await port.uploadBatch(
    [
      { path: 'a.html', body: Buffer.from('a') },
      { path: 'b.html', body: Buffer.from('b') },
    ],
    { parallel: 2 },
  );
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['a.html', 'b.html'],
  );
  assert.equal(state.calls.filter((c) => c.action === 'cos-put').length, 2);
  assert.equal(state.uploads, 1);
});
test('a batch with a protected, reserved or duplicate member writes nothing', async () => {
  const { manager, state } = managerFixture();
  const port = createCloudbaseHostingProvider({ manager, target });
  const ok = { path: 'a.html', body: Buffer.from('a') };
  for (const [files, parallel] of [
    [[ok, { path: '__auth/x.html', body: Buffer.from('x') }], 2],
    [[ok, { path: '404.html', body: Buffer.from('x') }], 2],
    [[ok, { path: 'google0123abcd.html', body: Buffer.from('x') }], 2],
    [[ok, ok], 2],
    [[], 1],
    [Array.from({ length: 13 }, (_, n) => ({ path: `${n}.html`, body: Buffer.from('x') })), 12],
    [[ok], 2],
    [[ok], 0],
  ])
    await assert.rejects(port.uploadBatch(files, { parallel }));
  assert.equal(state.uploads, 0);
  assert.equal(state.files.size, 0);
});
test('a foreign EnvInfo result cannot redirect later SDK calls', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  state.envId = 'foreign-env';
  const port = createCloudbaseHostingProvider({ manager, target });
  await assert.rejects(port.readConfiguration());
  assert.equal(
    state.calls.some((c) => c.action === 'DescribeStaticStore'),
    false,
  );
});
test('shared hosting bucket prefixes stay on upload/delete and bucket-global website changes are denied', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  state.store = {
    ...state.store,
    Bucket: '',
    ExternalStorage: {
      Enabled: true,
      BucketName: 'shared-bucket',
      Region: 'ap-shanghai',
      BasePath: 'environments/fixture-env',
    },
  };
  const port = createCloudbaseHostingProvider({ manager, target });
  await port.upload('canary/a.html', Buffer.from('hello'));
  assert.equal(state.files.has('environments/fixture-env/canary/a.html'), true);
  await port.remove('canary/a.html');
  assert.equal(state.files.size, 0);
  state.configuration.website.WebsiteConfiguration.ErrorDocument.Key = 'old-error.html';
  const before = await port.readConfiguration();
  const plan = prepareHostingConfiguration({
    target,
    before,
    errorDocument: 'errors/not-found.html',
  });
  await assert.rejects(port.configure(plan.changes[0]));
  assert.equal(state.calls.filter((c) => c.action === 'cos-website').length, 0);
});

test('SDK counts without a matching file completion do not confirm upload', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  state.fail = 'missing-callback';
  const port = createCloudbaseHostingProvider({ manager, target });
  await assert.rejects(port.upload('canary/a.html', Buffer.from('hello')));
});

test('server-managed route timestamps do not invalidate a matching configuration or its safe inverse', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  state.configuration.gateway.Domains[0].CreateTime = '2026-10-20T00:00:00Z';
  state.configuration.gateway.Domains[0].UpdateTime = '2026-10-20T00:00:00Z';
  const port = createCloudbaseHostingProvider({ manager, target });
  const before = await port.readConfiguration();
  const plan = prepareHostingConfiguration({
    target,
    before,
    previousCacheControl: 'no-store',
    cacheControl: 'no-cache',
  });
  await port.configure(plan.changes[0]);
  const current = await port.readConfiguration();
  assert.notEqual(current.gateway.Domains[0].UpdateTime, before.gateway.Domains[0].UpdateTime);
  const inverse = inverseHostingConfiguration({ plan, current });
  await port.configure(inverse.changes[0]);
  assert.equal(
    (await port.readConfiguration()).gateway.Domains[0].Extension.HeadersHandler
      .ResponseHeadersToAdd[1].Value,
    'no-store',
  );
});

test('CloudBase never uploads the reserved root fallback or deletes its configured error document', async () => {
  const { manager, state } = managerFixture({ initialConfiguration: domainConfiguration() });
  const port = createCloudbaseHostingProvider({ manager, target });
  await assert.rejects(port.upload('404.html', Buffer.from('not found')));
  await assert.rejects(port.remove('errors/not-found.html'));
  assert.equal(state.calls.length, 0);
  assert.equal(state.files.size, 0);
});

test('installed SDK inventory reads every page and retains exact object versions without cloud writes', async () => {
  const { manager, state } = managerFixture();
  state.listPageSize = 2;
  for (const path of ['a.txt', 'b.txt', 'c.txt']) state.files.set(path, Buffer.from(path));
  const port = createCloudbaseHostingProvider({ manager, target });
  const files = await port.readInventory();
  assert.deepEqual(
    files.map((entry) => entry.path),
    ['a.txt', 'b.txt', 'c.txt'],
  );
  assert.ok(files.every((entry) => entry.etag && entry.lastModified && entry.bytes === 5));
  assert.equal(state.calls.filter((call) => call.action === 'cos-list').length, 2);
  assert.equal(state.uploads, 0);
  assert.equal(state.deleted, 0);
});

test('installed SDK parallel failure followed by serial success confirms the exact file', async () => {
  const { manager, state } = managerFixture();
  const port = createCloudbaseHostingProvider({ manager, target });
  state.fail = 'parallel-fallback';
  assert.equal((await port.upload('canary/a.html', Buffer.from('hello'))).terminal, true);
  assert.equal(state.files.get('canary/a.html').toString(), 'hello');
  assert.equal(state.calls.filter((c) => c.action === 'cos-put').length, 1);
  assert.equal(state.uploads, 1);
});

test('an SDK fallback with a lost acknowledgement remains unknown and is never retried by the provider', async () => {
  const { manager, state } = managerFixture();
  const port = createCloudbaseHostingProvider({ manager, target });
  state.fail = 'parallel-lost-ack';
  await assert.rejects(port.upload('canary/a.html', Buffer.from('hello')));
  assert.equal(state.files.get('canary/a.html').toString(), 'hello');
  assert.equal(state.calls.filter((c) => c.action === 'cos-put').length, 1);
  assert.equal(state.uploads, 1);
});
