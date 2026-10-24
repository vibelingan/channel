import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  configuration,
  errorHtml,
  httpFixture,
  objectResponse,
} from './release-hosting-fixtures.mjs';
import { managerFixture } from './release-manager-fixture.mjs';
import { policy as basePolicy, clock, memoryStore } from './release-state-fixtures.mjs';
import { canaryArtifact, createCanaryPayload } from './release/canary.mjs';
import { createCloudbaseHostingProvider } from './release/hosting-provider.mjs';
import { executeManualCanary, planManualCanary } from './release/orchestrator.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

const policy = {
  ...basePolicy,
  enabled: true,
  workflowPath: '.github/workflows/seo-static-canary.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
};
async function setup(t) {
  const sdk = managerFixture();
  const timer = clock();
  const coordinator = createReleaseCoordinator({ store: memoryStore(), policy, clock: timer.now });
  const original = createCloudbaseHostingProvider({
    manager: sdk.manager,
    target: { envId: policy.envId, site: policy.siteOrigin },
  });
  const provider = {
    ...original,
    inventory: async () =>
      [...sdk.state.files.keys()].filter((x) => x.startsWith(policy.canaryPrefix)),
  };
  const http = await httpFixture(t, (req, res) => {
    const path = req.url.slice(1).replace(/\/$/, '/index.html');
    const body = sdk.state.files.get(path);
    objectResponse(req, res, {
      body: body ?? errorHtml,
      status: body ? 200 : 404,
      etag: `"${body?.toString('base64') ?? 'missing'}"`,
    });
  });
  const input = (variant, id) => {
    const directory = mkdtempSync(join(tmpdir(), 'manual-canary-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    createCanaryPayload({
      directory,
      policy,
      configuration: configuration(),
      variant,
      codeSha: 'a'.repeat(40),
      now: timer.now(),
    });
    return canaryArtifact({
      directory,
      policy,
      now: timer.now(),
      run: {
        repository: policy.repository,
        workflowPath: policy.workflowPath,
        event: 'workflow_dispatch',
        ref: policy.trustedRef,
        headSha: 'a'.repeat(40),
        runId: String(id),
        artifact: {
          id: String(id),
          runId: String(id),
          expired: false,
          expiresAt: '2027-01-01T00:00:00Z',
        },
      },
    });
  };
  const inputs = new Map([
    ['A', input('A', 101)],
    ['B', input('B', 102)],
  ]);
  const loadAccepted = async (run) => {
    const part = run.composition.static;
    const value = [...inputs.values()].find(
      (i) => i.envelope.artifact.artifactId === part.artifact.artifactId,
    );
    return canaryArtifact({
      directory: value.directory,
      policy,
      run: value.run,
      acceptedSeal: run.accepted.seals.static,
      now: timer.now(),
    });
  };
  const dependencies = {
    policy,
    coordinator,
    provider,
    loadAccepted,
    requestHttp: http.request,
    clock: timer.now,
    adapterOptions: { heartbeatMs: 50, operationTimeoutMs: 1000, pollIntervalMs: 1 },
  };
  const request = (action, expected = 'none') => ({
    action,
    expectedActivationId: expected,
    reason: 'controlled static canary',
    executorSha: 'b'.repeat(40),
  });
  const execute = async (label, req, id) => {
    const input =
      req.action === 'restore'
        ? await loadAccepted(await coordinator.runStatus(req.restoreRunId))
        : inputs.get(label);
    const planned = await planManualCanary({ ...dependencies, input, request: req });
    return executeManualCanary({
      ...dependencies,
      input,
      request: req,
      token: planned.review.token,
      runId: id,
      owner: { ownerRunId: id, runnerRef: `fixture:${id}` },
    });
  };
  return { sdk, timer, coordinator, dependencies, inputs, request, execute };
}
test('manual canary A to B to accepted A restores bytes with a new activation, no site/functions/deletes', async (t) => {
  const f = await setup(t);
  const A = await f.execute('A', f.request('initialize'), 'init');
  const B = await f.execute('B', f.request('publish', A.activation.activationId), 'publish');
  const restored = await f.execute(
    'A',
    { ...f.request('restore', B.activation.activationId), restoreRunId: 'init' },
    'restore',
  );
  assert.notEqual(restored.activation.activationId, A.activation.activationId);
  assert.match(f.sdk.state.files.get('__release-canary/index.html').toString(), /canary A/);
  assert.equal((await f.coordinator.status()).scope.active, null);
  assert.equal(f.sdk.state.deleted, 0);
  assert.equal(f.sdk.state.uploads, 3);
  assert.deepEqual([...f.sdk.state.files.keys()], ['__release-canary/index.html']);
  assert.ok(!f.sdk.state.calls.some((c) => /Modify|Delete|Function/.test(c.action)));
});
test('dry plan and disabled execution never acquire a lease or upload', async (t) => {
  const f = await setup(t);
  const args = { ...f.dependencies, input: f.inputs.get('A'), request: f.request('initialize') };
  const plan = await planManualCanary(args);
  assert.equal((await f.coordinator.status()).state, 'uninitialized');
  await assert.rejects(
    executeManualCanary({
      ...args,
      policy: { ...policy, enabled: false },
      token: plan.review.token,
      runId: 'blocked',
      owner: {},
    }),
    /disabled/,
  );
  assert.equal(f.sdk.state.uploads, 0);
});
test('occupied initial prefix, changed activation, drifted live bytes and expired review all stop before upload', async (t) => {
  const f = await setup(t);
  f.sdk.state.files.set('__release-canary/unrelated.html', Buffer.from('unowned'));
  await assert.rejects(f.execute('A', f.request('initialize'), 'bad'), /prefix/);
  assert.equal(f.sdk.state.uploads, 0);
  f.sdk.state.files.clear();
  const A = await f.execute('A', f.request('initialize'), 'init');
  await assert.rejects(f.execute('B', f.request('publish', 'wrong'), 'bad2'), /activation/);
  const args = {
    ...f.dependencies,
    input: f.inputs.get('B'),
    request: f.request('publish', A.activation.activationId),
  };
  const plan = await planManualCanary(args);
  f.timer.advance(1_800_001);
  await assert.rejects(
    executeManualCanary({
      ...args,
      token: plan.review.token,
      runId: 'expired',
      owner: { ownerRunId: 'expired', runnerRef: 'fixture:expired' },
    }),
    /expired/,
  );
  f.sdk.state.files.set('__release-canary/index.html', Buffer.from('external drift'));
  await assert.rejects(planManualCanary(args), /content mismatch/);
  assert.equal(f.sdk.state.uploads, 1);
});
test('failed upload remains unresolved and cannot be retried as a clean initialization', async (t) => {
  const f = await setup(t);
  f.sdk.state.fail = 'upload';
  await assert.rejects(f.execute('A', f.request('initialize'), 'failed'));
  const state = await f.coordinator.status({ scopeKey: 'canary' });
  assert.ok(state.pendingStep);
  assert.equal(state.scope.active, null);
  f.sdk.state.fail = null;
  await assert.rejects(f.execute('A', f.request('initialize'), 'retry'), /unresolved|busy/i);
  assert.equal(f.sdk.state.uploads, 1);
});

test('a changed activation while acquiring the lease invalidates the reviewed plan and releases cleanly', async (t) => {
  const f = await setup(t);
  const A = await f.execute('A', f.request('initialize'), 'init');
  const args = {
    ...f.dependencies,
    input: f.inputs.get('B'),
    request: f.request('publish', A.activation.activationId),
  };
  const planned = await planManualCanary(args);
  const coordinator = {
    ...f.coordinator,
    acquire: async (owner) => {
      await f.execute('A', f.request('publish', A.activation.activationId), 'other');
      return f.coordinator.acquire(owner);
    },
  };
  await assert.rejects(
    executeManualCanary({
      ...args,
      coordinator,
      token: planned.review.token,
      runId: 'stale',
      owner: { ownerRunId: 'stale', runnerRef: 'fixture:stale' },
    }),
    /activation/,
  );
  assert.equal(f.sdk.state.uploads, 2);
  assert.equal((await f.coordinator.status()).state, 'idle');
});
