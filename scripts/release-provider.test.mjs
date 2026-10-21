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
    OriginalHttpStatus: 'true',
    Charity404: 'false',
  };
  const port = createCloudbaseHostingProvider({ manager, target });
  const before = await port.readConfiguration();
  const plan = prepareHostingConfiguration({ target, before, errorDocument: '404.html' });
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
  const plan = prepareHostingConfiguration({ target, before, errorDocument: '404.html' });
  await assert.rejects(port.configure(plan.changes[0]));
  assert.equal(state.calls.filter((c) => c.action === 'cos-website').length, 0);
});

test('SDK counts without an actual matching per-file completion do not confirm upload', async () => {
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
