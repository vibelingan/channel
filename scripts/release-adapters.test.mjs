import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  executeHostingRecovery,
  planHostingRecovery,
  recoveryStateIdentity,
} from './hosting-recovery.mjs';
import { fixture } from './release-fixtures.mjs';
import {
  configuration,
  domainConfiguration,
  entry,
  errorHtml,
  httpFixture,
  objectResponse,
  target,
} from './release-hosting-fixtures.mjs';
import { managerFixture } from './release-manager-fixture.mjs';
import {
  clock,
  composition,
  memoryStore,
  policy,
  receipt,
  runner,
} from './release-state-fixtures.mjs';
import {
  createHostingRecoveryAdapters,
  hostingCoordinatorPlan,
} from './release/hosting-adapter.mjs';
import { withSiteUploadBatches } from './release/hosting-batches.mjs';
import {
  configurationHash,
  prepareHostingConfiguration,
} from './release/hosting-configuration.mjs';
import { createCloudbaseHostingProvider } from './release/hosting-provider.mjs';
import { identity } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

async function setup(
  t,
  {
    changes = false,
    operationTimeoutMs = 2000,
    heartbeatMs = 50,
    scopeKey = 'site',
    coordinatorTarget = {},
    cacheChange = false,
    batchedRemovals = 0,
  } = {},
) {
  const sdk = managerFixture(cacheChange ? { initialConfiguration: domainConfiguration() } : {});
  if (changes)
    sdk.state.configuration.website.WebsiteConfiguration.ErrorDocument.Key = 'old-error.html';
  const files = {
    'index.html': '<h1>Home A</h1>',
    '_astro/a.hash.js': 'console.log(1)',
    'errors/not-found.html': errorHtml,
  };
  if (scopeKey === 'canary') {
    files['__release-canary/index.html'] = '<h1>Canary A</h1>';
    files['__release-canary/asset.hash.js'] = 'console.log(1)';
  }
  const source = fixture(t, files);
  const conf = prepareHostingConfiguration({
    target,
    before: sdk.state.configuration,
    ...(changes ? { errorDocument: 'errors/not-found.html' } : {}),
    ...(cacheChange ? { previousCacheControl: 'no-store', cacheControl: 'no-cache' } : {}),
  });
  source.manifest.configuration = conf.after;
  source.manifest.configurationSha256 = configurationHash(conf.after);
  let plan = planHostingRecovery({
    ...source,
    target,
    currentOwnedPaths: ['retired/index.html'],
    publicProductPaths: [],
  });
  if (scopeKey === 'canary') {
    const { planSha256, ...body } = plan;
    body.scope = { kind: 'canary', prefix: '__release-canary/' };
    body.uploads = body.uploads.filter((entry) => entry.path.startsWith(body.scope.prefix));
    body.deletes = ['__release-canary/retired/index.html'];
    body.publicOutput = { products: [], legacy: false };
    body.stateSha256 = recoveryStateIdentity(body);
    plan = { ...body, planSha256: identity(body) };
    sdk.state.files.set('__release-canary/index.html', Buffer.from('<h1>Canary old</h1>'));
    sdk.state.files.set('__release-canary/retired/index.html', Buffer.from('retired'));
  }
  if (batchedRemovals) {
    const { planSha256, ...body } = plan;
    body.deletes = Array.from({ length: batchedRemovals }, (_, n) => `products/p-${n}/index.html`);
    body.stateSha256 = recoveryStateIdentity(body);
    plan = withSiteUploadBatches({ ...body, planSha256: identity(body) });
    for (const path of body.deletes) sdk.state.files.set(path, Buffer.from(`Old ${path}`));
  }
  sdk.state.files.set('index.html', Buffer.from('<h1>Old home</h1>'));
  sdk.state.files.set('retired/index.html', Buffer.from('retired'));
  const http = await httpFixture(t, (req, res) => {
    const path = req.url === '/' ? 'index.html' : req.url.slice(1).replace(/\/$/, '/index.html');
    const body = sdk.state.files.get(path);
    const domain = sdk.state.configuration.gateway.Domains[0];
    const headers = (domain.Extension ?? domain.Routes[0].Extension).HeadersHandler
      .ResponseHeadersToAdd;
    const cache = headers.find((h) => h.Key === 'Cache-Control').Value;
    objectResponse(req, res, {
      body: body ?? errorHtml,
      status: body ? 200 : 404,
      cache,
      etag: `"${entry('x', body ?? errorHtml).sha256}"`,
      mime: path.endsWith('.js') ? 'text/javascript' : 'text/html',
    });
  });
  const timer = clock();
  const boundPolicy = { ...policy, ...coordinatorTarget };
  const store = { ...memoryStore(), envId: boundPolicy.envId };
  const coordinator = createReleaseCoordinator({ store, policy: boundPolicy, clock: timer.now });
  const initialGuard = await coordinator.acquire(runner('baseline'));
  await coordinator.startRun({
    guard: initialGuard,
    runId: 'adopt-A',
    scopeKey,
    kind: 'adopt',
    composition: composition('A'),
    plan: { planSha256: 'a'.repeat(64), acceptanceHash: 'b'.repeat(64), stepCount: 1 },
  });
  const accept = await coordinator.beginStep({
    guard: initialGuard,
    runId: 'adopt-A',
    stepId: 'adopt',
    component: 'scope',
    kind: 'accept',
    beforeHash: 'b'.repeat(64),
    afterHash: 'b'.repeat(64),
    subject: 'accept',
    verifySubject: 'accept',
    executionId: 'bootstrap',
  });
  await coordinator.confirmStep({
    guard: initialGuard,
    runId: 'adopt-A',
    stepId: 'adopt',
    receipt: receipt(accept),
  });
  await coordinator.commitRun({
    guard: initialGuard,
    runId: 'adopt-A',
    changeSetRef: 'fixture-baseline',
  });
  const guard = await coordinator.acquire(runner('recovery'));
  const descriptor = hostingCoordinatorPlan(plan, conf);
  await coordinator.startRun({
    guard,
    runId: 'recover-A',
    scopeKey,
    kind: 'restore',
    deliveredComponents: ['static'],
    plan: descriptor,
  });
  const provider = createCloudbaseHostingProvider({ manager: sdk.manager, target });
  const adapters = createHostingRecoveryAdapters({
    plan,
    directory: source.directory,
    configurationPlan: conf,
    coordinator,
    guard,
    runId: 'recover-A',
    provider,
    request: http.request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs,
    heartbeatMs,
    pollIntervalMs: 2,
    requestTimeoutMs: 500,
  });
  return {
    ...sdk,
    source,
    plan,
    conf,
    http,
    coordinator,
    guard,
    adapters,
    descriptor,
    timer,
    store,
    provider,
  };
}

test('batched restoration journals exact removals before SDK effects and verifies every real HTTP 404', async (t) => {
  const f = await setup(t, { batchedRemovals: 25 });
  const removed = [];
  const original = f.provider.remove;
  const provider = {
    ...f.provider,
    remove: async (path, options) => {
      const status = await f.coordinator.status();
      assert.equal(status.pendingStep.subject.startsWith('remove-batch:'), true);
      assert(
        status.pendingStep.removals.some(
          (row) => row.path === path && /^[a-f0-9]{64}$/.test(row.beforeHash),
        ),
      );
      removed.push(path);
      return original(path, options);
    },
  };
  const adapters = createHostingRecoveryAdapters({
    plan: f.plan,
    directory: f.source.directory,
    configurationPlan: f.conf,
    coordinator: f.coordinator,
    guard: f.guard,
    runId: 'recover-A',
    provider,
    request: f.http.request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs: 5000,
    heartbeatMs: 50,
    pollIntervalMs: 2,
    requestTimeoutMs: 500,
  });
  await executeHostingRecovery(f.plan, adapters);
  assert.deepEqual([...removed].sort(), [...f.plan.deletes].sort());
  for (const path of f.plan.deletes) assert.equal(f.state.files.has(path), false);
  const records = f.store
    .inspect()
    .filter(([key, value]) => key.startsWith('steps/') && value.removals);
  assert.deepEqual(
    records.map(([, row]) => row.removals.length).sort((a, b) => a - b),
    [1, 12, 12],
  );
  for (const [, row] of records) {
    assert.equal(row.state, 'verified');
    assert.equal(row.receipt.evidence.length, row.removals.length);
    for (const observed of row.receipt.evidence)
      assert.deepEqual(
        observed.checks.map((check) => check.status),
        [404, 404, 304],
      );
  }
  assert.equal((await f.coordinator.runStatus('recover-A')).verifiedSteps, f.descriptor.stepCount);
});

test('lost deletion acknowledgement keeps the whole batch pending and prevents later batches', async (t) => {
  const f = await setup(t, { batchedRemovals: 25 });
  const removed = [];
  const provider = {
    ...f.provider,
    remove: async (path, options) => {
      removed.push(path);
      if (path !== f.plan.deletes[0]) await new Promise((done) => setTimeout(done, 20));
      const result = await f.provider.remove(path, options);
      if (path === f.plan.deletes[0]) throw Error('Actual delete completed, acknowledgement lost');
      return result;
    },
  };
  const adapters = createHostingRecoveryAdapters({
    plan: f.plan,
    directory: f.source.directory,
    configurationPlan: f.conf,
    coordinator: f.coordinator,
    guard: f.guard,
    runId: 'recover-A',
    provider,
    request: f.http.request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs: 5000,
    heartbeatMs: 50,
    pollIntervalMs: 2,
    requestTimeoutMs: 500,
  });
  await assert.rejects(executeHostingRecovery(f.plan, adapters));
  assert(removed.length <= 4);
  const status = await f.coordinator.status();
  assert.equal(status.pendingStep.state, 'unknown');
  assert.equal(status.pendingStep.removals.length, 12);
  assert.equal(f.state.files.has(f.plan.deletes[0]), false);
  assert.equal(f.state.files.has(f.plan.deletes[12]), true);
  await assert.rejects(f.coordinator.acquire(runner('another-writer')), { code: 'LEASE_BUSY' });
});

test('A2 + B1 + installed Manager SDK restores local HTTP bytes with a journal before every effect', async (t) => {
  const f = await setup(t);
  const before = (await f.coordinator.status()).scope.active;
  f.state.onEffect = () => {
    const targetRow = f.store.inspect().find(([key]) => key.startsWith('targets/'))?.[1];
    assert.ok(targetRow?.unresolvedOperation, 'intent must be committed before cloud effect');
  };
  const result = await executeHostingRecovery(f.plan, f.adapters);
  assert.equal(result.status, 'verified');
  assert.equal(f.state.files.has('retired/index.html'), false);
  assert.equal(f.state.files.get('index.html').toString(), '<h1>Home A</h1>');
  assert.deepEqual((await f.coordinator.status()).scope.active, before);
  assert.equal((await f.coordinator.runStatus('recover-A')).verifiedSteps, f.descriptor.stepCount);
  await f.coordinator.commitRun({
    guard: f.guard,
    runId: 'recover-A',
    changeSetRef: 'fixture-restore',
  });
  assert.notDeepEqual((await f.coordinator.status()).scope.active, before);
});
test('assets failure prevents HTML, discovery, deletion and activation', async (t) => {
  const f = await setup(t);
  f.state.fail = 'upload';
  await assert.rejects(executeHostingRecovery(f.plan, f.adapters));
  assert.equal(f.state.files.get('index.html').toString(), '<h1>Old home</h1>');
  assert.equal(f.state.deleted, 0);
  assert.equal((await f.coordinator.status()).pendingStep.state, 'unknown');
  assert.equal((await f.coordinator.runStatus('recover-A')).verifiedSteps, 0);
});
test('a configuration change has its own intent, before comparison and repeated SDK readback', async (t) => {
  const f = await setup(t, { changes: true });
  await executeHostingRecovery(f.plan, f.adapters);
  assert.equal(
    f.state.configuration.website.WebsiteConfiguration.ErrorDocument.Key,
    'errors/not-found.html',
  );
  assert.equal(f.state.calls.filter((c) => c.action === 'cos-website').length, 1);
  assert.equal((await f.coordinator.runStatus('recover-A')).verifiedSteps, f.descriptor.stepCount);
});
test('a changed local artifact is rejected before any cloud mutation', async (t) => {
  const f = await setup(t);
  writeFileSync(join(f.source.directory, '_astro/a.hash.js'), 'tampered');
  await assert.rejects(executeHostingRecovery(f.plan, f.adapters));
  assert.equal(f.state.uploads, 0);
});
test('provider target mismatch is rejected before any call', async (t) => {
  const f = await setup(t);
  assert.throws(() =>
    createHostingRecoveryAdapters({
      plan: f.plan,
      directory: f.source.directory,
      configurationPlan: f.conf,
      coordinator: f.coordinator,
      guard: f.guard,
      runId: 'recover-A',
      provider: { ...f.provider, target: { ...target, envId: 'wrong-env' } },
    }),
  );
});
test('timeout leaves an unknown intent and blocks the next upload even when the SDK settles late', async (t) => {
  const f = await setup(t, { operationTimeoutMs: 1500, heartbeatMs: 15 });
  let finish;
  let called = 0;
  const provider = {
    ...f.provider,
    upload: () => {
      called++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const adapters = createHostingRecoveryAdapters({
    plan: f.plan,
    directory: f.source.directory,
    configurationPlan: f.conf,
    coordinator: f.coordinator,
    guard: f.guard,
    runId: 'recover-A',
    provider,
    request: f.http.request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs: 1500,
    heartbeatMs: 15,
    pollIntervalMs: 2,
  });
  await assert.rejects(executeHostingRecovery(f.plan, adapters));
  assert.equal((await f.coordinator.status()).pendingStep.state, 'unknown');
  finish({ terminal: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await f.coordinator.status()).pendingStep.state, 'unknown');
  await assert.rejects(executeHostingRecovery(f.plan, adapters));
  assert.equal(called, 1);
});
test('loss of lease during SDK work never confirms or starts the next file', async (t) => {
  const f = await setup(t, { operationTimeoutMs: 2000, heartbeatMs: 10 });
  let invoked = 0;
  const provider = {
    ...f.provider,
    upload: () => {
      invoked++;
      f.timer.advance(180001);
      return new Promise((resolve) => setTimeout(() => resolve({ terminal: true }), 80));
    },
  };
  const adapters = createHostingRecoveryAdapters({
    plan: f.plan,
    directory: f.source.directory,
    configurationPlan: f.conf,
    coordinator: f.coordinator,
    guard: f.guard,
    runId: 'recover-A',
    provider,
    request: f.http.request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs: 2000,
    heartbeatMs: 10,
    pollIntervalMs: 2,
  });
  await assert.rejects(executeHostingRecovery(f.plan, adapters));
  assert.equal(invoked, 1);
  assert.equal((await f.coordinator.status()).state, 'stalled');
  assert.notEqual((await f.coordinator.status()).pendingStep.state, 'verified');
});

test('a recomputed canary plan still cannot escape its owned prefix or change global configuration', async (t) => {
  const f = await setup(t);
  const rehash = (p) => {
    p.stateSha256 = recoveryStateIdentity(p);
    const { planSha256, ...body } = p;
    p.planSha256 = identity(body);
    return p;
  };
  const escaped = rehash({
    ...structuredClone(f.plan),
    scope: { kind: 'canary', prefix: '__release-canary/' },
  });
  assert.throws(() => hostingCoordinatorPlan(escaped, f.conf));
});
test('before-state response arriving after deadline cannot create a late intent or start upload', async (t) => {
  const f = await setup(t);
  let finish;
  const request = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const adapters = createHostingRecoveryAdapters({
    plan: f.plan,
    directory: f.source.directory,
    configurationPlan: f.conf,
    coordinator: f.coordinator,
    guard: f.guard,
    runId: 'recover-A',
    provider: f.provider,
    request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs: 1500,
    heartbeatMs: 15,
    pollIntervalMs: 2,
  });
  await assert.rejects(executeHostingRecovery(f.plan, adapters));
  finish({ status: 200, body: Buffer.from('old') });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.state.uploads, 0);
  assert.equal((await f.coordinator.status()).pendingStep, null);
});
test('mutable callback arguments cannot redirect the artifact upload after an await', async (t) => {
  const f = await setup(t);
  const original = f.plan.uploads[0];
  const entryArg = { ...original };
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let observed = false;
  const request = async (...args) => {
    if (!observed) {
      observed = true;
      await barrier;
    }
    return f.http.request(...args);
  };
  const adapters = createHostingRecoveryAdapters({
    plan: f.plan,
    directory: f.source.directory,
    configurationPlan: f.conf,
    coordinator: f.coordinator,
    guard: f.guard,
    runId: 'recover-A',
    provider: f.provider,
    request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs: 1000,
    heartbeatMs: 20,
    pollIntervalMs: 2,
  });
  const ctx = {
    executionId: 'manual-execution',
    planSha256: f.plan.planSha256,
    subject: `upload:${original.path}`,
    expectedHash: original.sha256,
  };
  const promise = adapters.upload(entryArg, ctx);
  while (!observed) await new Promise((resolve) => setTimeout(resolve, 1));
  entryArg.path = 'outside.html';
  ctx.subject = 'upload:outside.html';
  release();
  await promise;
  assert.equal(f.state.files.has('outside.html'), false);
  assert.equal(f.state.files.has(original.path), true);
});

test('canary restores only its prefix and does not move the whole-site baseline or configuration', async (t) => {
  const f = await setup(t, { scopeKey: 'canary' });
  const configurationBefore = configurationHash(f.state.configuration);
  await executeHostingRecovery(f.plan, f.adapters);
  assert.equal(f.state.files.get('index.html').toString(), '<h1>Old home</h1>');
  assert.equal(f.state.files.get('__release-canary/index.html').toString(), '<h1>Canary A</h1>');
  assert.equal(f.state.files.has('__release-canary/retired/index.html'), false);
  assert.equal(configurationHash(f.state.configuration), configurationBefore);
  await f.coordinator.commitRun({
    guard: f.guard,
    runId: 'recover-A',
    changeSetRef: 'canary-recovery',
  });
  assert.equal((await f.coordinator.status()).scope.active, null);
  assert.ok((await f.coordinator.status({ scopeKey: 'canary' })).scope.active);
});
test('configuration that never converges stays unknown without marking scope acceptance', async (t) => {
  const f = await setup(t, { changes: true });
  const provider = {
    ...f.provider,
    configure: async () => ({ terminal: true, providerOperationId: 'fixture-accepted' }),
  };
  const adapters = createHostingRecoveryAdapters({
    plan: f.plan,
    directory: f.source.directory,
    configurationPlan: f.conf,
    coordinator: f.coordinator,
    guard: f.guard,
    runId: 'recover-A',
    provider,
    request: f.http.request,
    errorDocument: entry('errors/not-found.html', errorHtml),
    operationTimeoutMs: 2000,
    heartbeatMs: 15,
    pollIntervalMs: 5,
  });
  await assert.rejects(executeHostingRecovery(f.plan, adapters));
  const pending = (await f.coordinator.status()).pendingStep;
  assert.ok(pending.subject.startsWith('configure:'));
  assert.equal(pending.state, 'unknown');
  assert.notEqual(
    (await f.coordinator.runStatus('recover-A')).verifiedSteps,
    f.descriptor.stepCount,
  );
});

test('a lease for another environment or origin cannot authorize the hosting provider target', async (t) => {
  for (const coordinatorTarget of [
    { envId: 'other-env' },
    { siteOrigin: 'https://other.example' },
  ]) {
    const f = await setup(t, { coordinatorTarget });
    await assert.rejects(executeHostingRecovery(f.plan, f.adapters));
    assert.equal(f.state.uploads, 0);
    assert.equal(f.state.deleted, 0);
    assert.equal(f.state.calls.length, 0);
  }
});

test('configuration convergence compares actual settings while retaining the original artifact snapshot identity', async (t) => {
  const f = await setup(t, { cacheChange: true });
  const result = await executeHostingRecovery(f.plan, f.adapters);
  const configured = result.receipts.find((item) => item.subject === 'configure');
  assert.equal(configured.observedHash, f.plan.configurationSha256);
  assert.notEqual(configured.rawConfigurationSha256, f.plan.configurationSha256);
  assert.equal((await f.coordinator.runStatus('recover-A')).verifiedSteps, f.descriptor.stepCount);
});
