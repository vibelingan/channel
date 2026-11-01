import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  clock,
  composition,
  policy as fixturePolicy,
  memoryStore,
  plan,
  receipt,
  stepInput,
} from './release-state-fixtures.mjs';
import { recoverCatalogPreparation } from './release/catalog-preparation-recovery.mjs';
import { hostingBatchBeforeHash, hostingBatchHash } from './release/hosting-batches.mjs';
import { identity } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

const policy = {
  ...fixturePolicy,
  repository: 'vibelingan/channel',
  region: 'ap-shanghai',
  trustedRef: 'refs/heads/feat/seo-foundation',
  workflowPath: '.github/workflows/seo-static-canary.yml',
};
const oldRun = '41303614689';
const oldOwner = `site-${oldRun}-1`;
const codeSha = '4e517306715243341bbdfad93f0a1a9f29afb0e8';
async function fixture({ inheritedDirty = false } = {}) {
  const store = memoryStore();
  const time = clock();
  const coordinator = createReleaseCoordinator({ store, policy, clock: time.now });
  const accepted = await coordinator.acquire({ ownerRunId: 'accepted', runnerRef: 'previous' });
  const parts = composition();
  parts.static.artifact.repository = policy.repository;
  await coordinator.startRun({
    guard: accepted,
    runId: 'accepted',
    scopeKey: 'site',
    kind: 'adopt',
    plan: plan(1),
    composition: parts,
  });
  const step = await coordinator.beginStep({
    guard: accepted,
    runId: 'accepted',
    ...stepInput('accept'),
  });
  await coordinator.confirmStep({
    guard: accepted,
    runId: 'accepted',
    stepId: step.stepId,
    receipt: receipt(step),
  });
  await coordinator.commitRun({
    guard: accepted,
    runId: 'accepted',
    changeSetRef: 'fixture accepted',
  });
  const baseline = (await coordinator.status()).scope.baseline;
  const dirtyRunId = 'site-41313740695-1';
  let dirtyProof;
  if (inheritedDirty) {
    const runnerRef = 'github:vibelingan/channel:41313740695:attempt-1';
    const guard = await coordinator.acquire({ ownerRunId: dirtyRunId, runnerRef });
    const parts = composition('B');
    parts.static.artifact.repository = policy.repository;
    parts.static.artifact.runId = '41313740695';
    await coordinator.startRun({
      guard,
      runId: dirtyRunId,
      scopeKey: 'site',
      kind: 'publish',
      deliveredComponents: ['static'],
      plan: plan(2),
      composition: parts,
    });
    const members = [
      {
        path: 'products/p-one/index.html',
        bytes: 10,
        beforeHash: 'a'.repeat(64),
        sha256: 'b'.repeat(64),
      },
    ];
    const batch = hostingBatchHash(members);
    const failed = await coordinator.beginStep({
      guard,
      runId: dirtyRunId,
      ...stepInput(),
      members,
      beforeHash: hostingBatchBeforeHash(members),
      afterHash: batch,
      subject: `upload-batch:${batch}`,
      verifySubject: `read-batch:${batch}`,
    });
    await coordinator.recordSubmitted({
      guard,
      runId: dirtyRunId,
      stepId: failed.stepId,
      receipt: receipt(failed, 'submitted'),
    });
    time.advance(180001);
    const stopped = await coordinator.status();
    dirtyProof = {
      runnerRef,
      checkedAt: time.now(),
      job: {
        status: 'completed',
        evidenceRef: `github:41313740695:attempt-1:job-124847:failure:source-${parts.static.codeSha}`,
      },
      cloud: {
        status: 'quiescent',
        kind: 'stopped-site-html-batch',
        operationId: failed.operationId,
        observedHash: failed.afterHash,
        evidenceRef: `candidate:20:batch:${failed.afterHash}:three-cache-modes:absent:seo-catalog-region-41313740695-1`,
      },
    };
    await coordinator.reconcile({
      expectedVersion: stopped.target.version,
      expectedFence: guard.fence,
      proof: dirtyProof,
    });
  }
  await coordinator.acquire({
    ownerRunId: oldOwner,
    runnerRef: `github:${policy.repository}:${oldRun}:attempt-1`,
  });
  time.advance(180001);
  const job = {
    id: 124839446391,
    run_id: Number(oldRun),
    head_sha: codeSha,
    name: 'site_delivery / site',
    status: 'completed',
    conclusion: 'failure',
    started_at: new Date(time.now() - 300000).toISOString(),
    completed_at: new Date(time.now() - 150000).toISOString(),
  };
  const run = {
    id: Number(oldRun),
    run_attempt: 1,
    head_sha: codeSha,
    head_branch: 'feat/seo-foundation',
    path: policy.workflowPath,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    updated_at: job.completed_at,
    repository: { id: 1, full_name: policy.repository },
    head_repository: { id: 1, full_name: policy.repository },
  };
  const regional = {
    schemaVersion: 1,
    purpose: 'catalog-seo-regional-v1',
    runId: oldOwner,
    codeSha,
    functionName: `seo-catalog-region-${oldRun}-1`,
    environment: policy.envId,
    websiteWrites: 0,
    businessWrites: 0,
    created: true,
    cleaned: true,
    unconfirmed: false,
    calls: [
      { requestId: 'health-id', action: 'health', state: 'completed' },
      {
        requestId: 'seed-id',
        action: 'seed',
        state: 'failed',
        diagnostic: { sdkCode: 'REGIONAL_LEASE_CHANGED' },
      },
    ],
  };
  const f = {
    store,
    time,
    coordinator,
    baseline,
    run,
    job,
    regional,
    names: [],
    reads: [],
    rawRun: null,
    dirtyRunId,
    dirtyProof,
  };
  const github = {
    api: async (path) => {
      f.reads.push(path);
      if (path === `/actions/runs/${oldRun}/attempts/1`) return structuredClone(run);
      if (path === `/actions/runs/${oldRun}/attempts/1/jobs?per_page=100&page=1`)
        return { total_count: 1, jobs: [structuredClone(job)] };
      throw Error('Unexpected GitHub path');
    },
  };
  f.options = {
    coordinator,
    github,
    policy,
    functions: {
      listFunctions: async (limit, offset) =>
        f.names.slice(offset, offset + limit).map((FunctionName) => ({ FunctionName })),
    },
    readPreparationRun: async (owner) => {
      if (inheritedDirty && owner === dirtyRunId) return coordinator.runStatus(dirtyRunId);
      assert.equal(owner, oldOwner);
      return f.rawRun;
    },
    loadEvidence: async (input) => {
      assert.equal(input.ownerRunId, oldOwner);
      assert.equal(input.artifactName, `site-delivery-evidence-${oldRun}-1`);
      assert.equal(input.regionalPath, 'regional/result.json');
      return structuredClone(f.regional);
    },
    now: time.now,
  };
  return f;
}

test('confirmed stopped preupload preparation releases only its expired lease and preserves baseline', async () => {
  const f = await fixture();
  assert.equal((await f.coordinator.status()).state, 'stalled');
  const status = await recoverCatalogPreparation(f.options);
  assert.equal(status.state, 'idle');
  assert.equal(status.target.lease, null);
  assert.deepEqual(status.scope.baseline, f.baseline);
  const after = f.store.inspect();
  const result = await recoverCatalogPreparation(f.options);
  assert.equal(result.state, 'idle');
  assert.deepEqual(f.store.inspect(), after);
});

test('cancelled preparation may release its own lease while retaining an already-reconciled failed delivery', async () => {
  const f = await fixture({ inheritedDirty: true });
  const before = await f.coordinator.runStatus(f.dirtyRunId);
  const status = await recoverCatalogPreparation(f.options);
  assert.equal(status.state, 'recovery-required');
  assert.equal(status.target.lease, null);
  assert.equal(status.target.dirtyRunId, f.dirtyRunId);
  assert.deepEqual(status.scope.baseline, f.baseline);
  assert.deepEqual(await f.coordinator.runStatus(f.dirtyRunId), before);
  assert.deepEqual(status.target.lastReconciliation.inheritedReconciliation, {
    runId: f.dirtyRunId,
    proof: f.dirtyProof,
    sha256: identity(f.dirtyProof),
  });
});

function pendingWorkers(f) {
  f.regional.cleaned = false;
  const ownerRunId = oldOwner;
  const runnerRef = `github:${policy.repository}:${oldRun}:attempt-1`;
  const targetId = f.coordinator.targetId;
  const releaseName = `seo-release-region-${oldRun}-1`;
  const release = {
    schemaVersion: 1,
    purpose: 'release-regional-v1',
    environment: policy.envId,
    ownerRunId,
    runnerRef,
    targetId,
    codeSha,
    functionName: releaseName,
    created: true,
    cleaned: false,
    unconfirmed: false,
    websiteWrites: 0,
    businessWrites: 0,
    calls: [
      { operationId: 'health-1', method: 'health', state: 'completed' },
      { operationId: 'acquire-1', method: 'acquire', state: 'completed' },
    ],
  };
  const details = new Map();
  for (const [name, kind] of [
    [f.regional.functionName, 'catalog'],
    [releaseName, 'release'],
  ]) {
    const variables =
      kind === 'catalog'
        ? {
            TCB_ENV: policy.envId,
            CATALOG_REGIONAL_RUN_ID: ownerRunId,
            CATALOG_REGIONAL_TARGET_ID: targetId,
            CATALOG_REGIONAL_SITE_ORIGIN: policy.siteOrigin,
            CATALOG_REGIONAL_TOKEN_DIGEST: 'a'.repeat(64),
            CATALOG_REGIONAL_RUNNER_REF: runnerRef,
          }
        : {
            TCB_ENV: policy.envId,
            RELEASE_REGIONAL_OWNER_RUN_ID: ownerRunId,
            RELEASE_REGIONAL_TARGET_ID: targetId,
            RELEASE_REGIONAL_SITE_ORIGIN: policy.siteOrigin,
            RELEASE_REGIONAL_TOKEN_DIGEST: 'a'.repeat(64),
            RELEASE_REGIONAL_RUNNER_REF: runnerRef,
            RELEASE_REGIONAL_REPOSITORY: policy.repository,
          };
    details.set(name, {
      FunctionName: name,
      Type: 'Event',
      Runtime: 'Nodejs20.19',
      Handler: 'index.main',
      Description: `channel-${kind === 'catalog' ? 'catalog' : 'release'}-regional-v1`,
      Namespace: policy.envId,
      FunctionId: `function-${kind}`,
      AddTime: '2026-11-02 10:00:00',
      ModTime: '2026-11-02 10:00:00',
      CodeSize: 1000,
      Timeout: 45,
      MemorySize: 256,
      Layers: [],
      Triggers: [],
      Status: 'Active',
      AvailableStatus: 'Available',
      CodeSha256: 'b'.repeat(64),
      Environment: { Variables: Object.entries(variables).map(([Key, Value]) => ({ Key, Value })) },
    });
  }
  f.names = [...details.keys(), 'other-app'];
  f.cleaned = [];
  f.probes = [];
  f.cleanupEvents = [];
  f.workerDetails = details;
  f.releaseEvidence = release;
  f.options.functions.getFunctionDetail = async (name) => structuredClone(details.get(name));
  f.options.functions.invokeFunction = async (name, event) => {
    assert.deepEqual(event, {}, 'Only the reviewed empty-request rejection path may run');
    f.probes.push(name);
    return {
      RequestId: 'probe-request',
      InvokeFinished: 1,
      RetCode: 0,
      RetMsg: JSON.stringify(
        name === releaseName
          ? {
              purpose: 'release-regional-v1',
              envId: policy.envId,
              ownerRunId,
              runnerRef,
              targetId,
              codeSha,
              ok: false,
              error: { code: 'RELEASE_REGIONAL_REQUEST' },
            }
          : {
              purpose: 'catalog-seo-regional-v1',
              runId: ownerRunId,
              codeSha,
              ok: false,
              error: { code: 'REGIONAL_INVALID_REQUEST' },
            },
      ),
    };
  };
  f.options.functions.deleteFunction = async (name) => {
    f.cleaned.push(name);
    f.names = f.names.filter((value) => value !== name);
  };
  f.options.manager = {
    functions: f.options.functions,
    getManagerConfig: () => ({ envId: policy.envId, region: policy.region }),
    commonService: (service, version) => {
      assert.equal(service, 'tcb');
      assert.equal(version, '2018-06-08');
      return {
        call: async (request) => {
          assert.deepEqual(request, {
            Action: 'DeleteFunction',
            Param: { EnvId: policy.envId, FunctionName: request.Param.FunctionName },
          });
          assert.ok([f.regional.functionName, releaseName].includes(request.Param.FunctionName));
          return f.options.functions.deleteFunction(request.Param.FunctionName);
        },
      };
    },
    currentEnvironment: () => ({
      getEnvId: () => policy.envId,
      getAccessService: () => ({
        getAccessList: async () => ({ RequestId: 'legacy-route', APISet: [], Total: 0 }),
      }),
      getEnvService: () => ({
        describeHttpServiceRoute: async () => ({ RequestId: 'routes', TotalCount: 0, Domains: [] }),
      }),
    }),
  };
  f.options.onCleanup = async (event) => f.cleanupEvents.push(structuredClone(event));
  f.options.wait = async () => {};
  f.options.loadEvidence = async (input) =>
    structuredClone(input.regionalPath === 'regional/result.json' ? f.regional : release);
  return f;
}

test('cancelled preparation cleans only its two verified private workers and records new evidence', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  const original = structuredClone(f.regional);
  const status = await recoverCatalogPreparation(f.options);
  assert.equal(status.state, 'recovery-required');
  assert.equal(status.target.dirtyRunId, f.dirtyRunId);
  assert.deepEqual(f.cleaned, [f.regional.functionName, f.releaseEvidence.functionName]);
  assert.deepEqual(f.probes, f.cleaned);
  assert.deepEqual(f.names, ['other-app']);
  assert.ok(f.cleanupEvents.length >= 3);
  assert.deepEqual(f.regional, original, 'Original failed-run receipt is immutable');
  assert.equal(
    status.supplementalRecovery.functions.every((row) => row.state === 'absent'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(f.cleanupEvents), /TOKEN_DIGEST|"Value"|aaaaaaa/);
});

test('a later cancelled preupload may have finished the fixed old-catalog cleanup action', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  f.regional.calls.push({
    requestId: 'recover-old-catalog',
    action: 'recovery.clear',
    state: 'completed',
  });
  assert.equal((await recoverCatalogPreparation(f.options)).state, 'recovery-required');
});

test('unknown or changed inherited failed-delivery proofs never release the preparation lease', async () => {
  for (const change of ['running', 'accepted', 'proof', 'source', 'lineage']) {
    const f = await fixture({ inheritedDirty: true });
    const key = identity({ targetId: f.coordinator.targetId, runId: f.dirtyRunId });
    const row = await f.coordinator.runStatus(f.dirtyRunId);
    if (change === 'running') row.state = 'RUNNING';
    if (change === 'accepted') row.accepted = { sourceRunId: f.dirtyRunId };
    if (change === 'proof') row.reconciliation.cloud.kind = 'some-other-recovery';
    if (change === 'source') row.composition.static.codeSha = 'f'.repeat(40);
    if (change === 'lineage') {
      const status = await f.coordinator.status();
      f.store.replace('targets', f.coordinator.targetId, {
        ...status.target,
        lastReconciliation: { unrelated: true },
      });
    } else f.store.replace('runs', key, row);
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('cleanup requires exact function ownership, private entrypoints and original source evidence', async () => {
  for (const change of [
    'owner',
    'environment',
    'namespace',
    'memory',
    'timeout',
    'layers',
    'source',
    'timer',
    'http-type',
    'legacy-http',
    'http-route',
    'release-receipt',
    'manager-env',
  ]) {
    const f = pendingWorkers(await fixture({ inheritedDirty: true }));
    const detail = f.workerDetails.get(f.releaseEvidence.functionName);
    if (change === 'owner')
      detail.Environment.Variables.find(
        (row) => row.Key === 'RELEASE_REGIONAL_OWNER_RUN_ID',
      ).Value = 'other-owner';
    if (change === 'environment')
      detail.Environment.Variables.find((row) => row.Key === 'TCB_ENV').Value =
        'another-environment';
    if (change === 'namespace') detail.Namespace = 'another-environment';
    if (change === 'memory') detail.MemorySize = 512;
    if (change === 'timeout') detail.Timeout = 900;
    if (change === 'layers') detail.Layers = [{ LayerName: 'other-app' }];
    if (change === 'timer') detail.Triggers = [{ Type: 'timer' }];
    if (change === 'http-type') detail.Type = 'HTTP';
    if (change === 'source') {
      const invoke = f.options.functions.invokeFunction;
      f.options.functions.invokeFunction = async (...args) => {
        const response = await invoke(...args);
        response.RetMsg = JSON.stringify({
          ...JSON.parse(response.RetMsg),
          codeSha: 'e'.repeat(40),
        });
        return response;
      };
    }
    if (change === 'legacy-http') {
      f.options.manager.currentEnvironment = () => ({
        getEnvId: () => policy.envId,
        getAccessService: () => ({
          getAccessList: async () => ({
            RequestId: 'route',
            Total: 1,
            APISet: [{ Name: f.regional.functionName }],
          }),
        }),
      });
    }
    if (change === 'http-route') {
      const env = f.options.manager.currentEnvironment();
      f.options.manager.currentEnvironment = () => ({
        ...env,
        getEnvService: () => ({
          describeHttpServiceRoute: async () => ({
            RequestId: 'routes',
            TotalCount: 1,
            Domains: [
              {
                Domain: 'example.test',
                Routes: [
                  { UpstreamResourceName: f.regional.functionName, UpstreamResourceType: 'SCF' },
                ],
              },
            ],
          }),
        }),
      });
    }
    if (change === 'release-receipt')
      f.releaseEvidence.calls.push({
        method: 'beginStep',
        operationId: 'begin-1',
        state: 'completed',
      });
    if (change === 'manager-env')
      f.options.manager.getManagerConfig = () => ({ envId: 'other', region: policy.region });
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.deepEqual(f.cleaned, [], change);
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('changed package or baseline between readback and deletion blocks every cloud deletion', async () => {
  for (const change of ['package', 'function-id', 'baseline']) {
    const f = pendingWorkers(await fixture({ inheritedDirty: true }));
    const invoke = f.options.functions.invokeFunction;
    f.options.functions.invokeFunction = async (...args) => {
      const result = await invoke(...args);
      if (args[0] === f.releaseEvidence.functionName) {
        if (change === 'package')
          f.workerDetails.get(f.regional.functionName).CodeSha256 = 'f'.repeat(64);
        else if (change === 'function-id')
          f.workerDetails.get(f.regional.functionName).FunctionId = 'new-incarnation';
        else {
          const key = `${f.coordinator.targetId}-site`;
          const row = f.store.inspect().find(([id]) => id === `scopes/${key}`)[1];
          const pointer = { ...row.baseline, activationId: 'changed' };
          f.store.replace('scopes', key, { ...row, active: pointer, baseline: pointer });
        }
      }
      return result;
    };
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.deepEqual(f.cleaned, []);
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('real detail shape without CodeSha256 still binds deletion to its stable function incarnation', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  for (const [name, detail] of f.workerDetails)
    f.workerDetails.set(
      name,
      Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'CodeSha256')),
    );
  const status = await recoverCatalogPreparation(f.options);
  assert.equal(status.state, 'recovery-required');
  assert.equal(status.supplementalRecovery.functions[0].functionId, 'function-catalog');
  assert.match(status.supplementalRecovery.functions[0].identitySha256, /^[a-f0-9]{64}$/);
});

test('a modern HTTP binding or duplicate domain on the second page prevents cleanup', async () => {
  for (const duplicate of [false, true]) {
    const f = pendingWorkers(await fixture({ inheritedDirty: true }));
    const env = f.options.manager.currentEnvironment();
    const offsets = [];
    f.options.manager.currentEnvironment = () => ({
      ...env,
      getEnvService: () => ({
        describeHttpServiceRoute: async (input) => {
          assert.deepEqual(input, { EnvId: policy.envId, Offset: input.Offset, Limit: 100 });
          offsets.push(input.Offset);
          return {
            RequestId: 'routes',
            TotalCount: 101,
            Domains:
              input.Offset === 0
                ? Array.from({ length: 100 }, (_, index) => ({
                    Domain: `domain-${index}.test`,
                    Routes: [],
                  }))
                : [
                    {
                      Domain: duplicate ? 'domain-0.test' : 'domain-100.test',
                      Routes: duplicate
                        ? []
                        : [
                            {
                              UpstreamResourceType: 'SCF',
                              UpstreamResourceName: f.regional.functionName,
                            },
                          ],
                    },
                  ],
          };
        },
      }),
    });
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.deepEqual(offsets, [0, 100]);
    assert.deepEqual(f.cleaned, []);
    assert.deepEqual(f.probes, []);
  }
});

test('lost deletion replies use inventory readback and never resubmit deletion', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  const remove = f.options.functions.deleteFunction;
  f.options.functions.deleteFunction = async (name) => {
    await remove(name);
    throw Error('SECRET_DELETE_REPLY');
  };
  assert.equal((await recoverCatalogPreparation(f.options)).state, 'recovery-required');
  assert.deepEqual(f.cleaned, [f.regional.functionName, f.releaseEvidence.functionName]);
  assert.doesNotMatch(JSON.stringify(f.cleanupEvents), /SECRET_DELETE_REPLY/);
});

test('uncertain deletion or failed evidence persistence retains the preparation lock', async () => {
  for (const change of ['delete', 'evidence']) {
    const f = pendingWorkers(await fixture({ inheritedDirty: true }));
    if (change === 'delete')
      f.options.functions.deleteFunction = async (name) => {
        f.cleaned.push(name);
        throw Error('SECRET_DELETE');
      };
    else
      f.options.onCleanup = async () => {
        throw Error('SECRET_PERSISTENCE');
      };
    const cause = await recoverCatalogPreparation(f.options).catch((value) => value);
    assert.ok(cause instanceof Error);
    assert.doesNotMatch(String(cause), /SECRET_/);
    assert.equal((await f.coordinator.status()).state, 'stalled');
    if (change === 'delete') {
      assert.equal(cause.code, 'CATALOG_PREPARATION_CLEANUP_NEEDS_READBACK');
      assert.deepEqual(f.cleaned, [f.regional.functionName]);
      assert.equal(f.cleanupEvents.at(-1).functions[0].state, 'deleting');
    } else assert.deepEqual(f.cleaned, []);
  }
});

test('already absent workers with an incomplete original receipt receive separate supplemental proof', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  f.names = ['other-app'];
  const status = await recoverCatalogPreparation(f.options);
  assert.equal(status.state, 'recovery-required');
  assert.equal(
    status.supplementalRecovery.functions.every((row) => row.state === 'absent'),
    true,
  );
  assert.deepEqual(f.cleaned, []);
  assert.deepEqual(f.probes, []);
  assert.equal(f.regional.cleaned, false);
});

test('a function that reappeared after confirmed cleanup is not treated as the original worker', async () => {
  for (const worker of ['catalog', 'release']) {
    const f = pendingWorkers(await fixture({ inheritedDirty: true }));
    if (worker === 'catalog') f.regional.cleaned = true;
    else f.releaseEvidence.cleaned = true;
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.deepEqual(f.cleaned, []);
    assert.deepEqual(f.probes, []);
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('the public delete endpoint cannot delete HTTP routes even if the higher-level helper would', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  const remove = f.options.functions.deleteFunction;
  f.options.functions.deleteFunction = undefined;
  f.options.manager.commonService = (service, version) => {
    assert.equal(service, 'tcb');
    assert.equal(version, '2018-06-08');
    return { call: (request) => remove(request.Param.FunctionName) };
  };
  assert.equal((await recoverCatalogPreparation(f.options)).state, 'recovery-required');
  assert.equal(f.cleaned.length, 2);
});

test('legacy empty-binding inspection uses only the proven SDK function-name argument', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  const env = f.options.manager.currentEnvironment();
  f.options.manager.currentEnvironment = () => ({
    ...env,
    getAccessService: () => ({
      getAccessList: async (input) => {
        assert.deepEqual(Object.keys(input), ['name']);
        assert.ok([f.regional.functionName, f.releaseEvidence.functionName].includes(input.name));
        return { RequestId: 'legacy-request', APISet: [], Total: 0 };
      },
    }),
  });
  assert.equal((await recoverCatalogPreparation(f.options)).state, 'recovery-required');
});

test('a legacy empty-binding response may omit Total when RequestId and APISet are valid', async () => {
  const f = pendingWorkers(await fixture({ inheritedDirty: true }));
  const env = f.options.manager.currentEnvironment();
  f.options.manager.currentEnvironment = () => ({
    ...env,
    getAccessService: () => ({
      getAccessList: async () => ({ RequestId: 'legacy-request', APISet: [] }),
    }),
  });
  assert.equal((await recoverCatalogPreparation(f.options)).state, 'recovery-required');
  assert.equal(f.cleaned.length, 2);
});

test('an optional legacy Total must be exactly zero and RequestId must be a nonempty string', async () => {
  for (const response of [
    ...[1, -1, '0', null, undefined, {}, Number.NaN].map((Total) => ({
      RequestId: 'legacy-request',
      APISet: [],
      Total,
    })),
    ...[undefined, null, 1, '', '   '].map((RequestId) => ({ RequestId, APISet: [], Total: 0 })),
  ]) {
    const f = pendingWorkers(await fixture({ inheritedDirty: true }));
    const env = f.options.manager.currentEnvironment();
    f.options.manager.currentEnvironment = () => ({
      ...env,
      getAccessService: () => ({ getAccessList: async () => response }),
    });
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.deepEqual(f.cleaned, []);
    assert.deepEqual(f.probes, []);
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('installed Manager exposes exactly the public ownership and cleanup methods used here', () => {
  const require = createRequire(new URL('../package.json', import.meta.url));
  const Manager = require('@cloudbase/manager-node');
  const manager = new Manager({ envId: policy.envId, region: policy.region });
  assert.equal(manager.getManagerConfig().envId, policy.envId);
  assert.equal(manager.functions, manager.functions);
  assert.equal(typeof manager.commonService('tcb', '2018-06-08').call, 'function');
  const env = manager.currentEnvironment();
  assert.equal(env.getEnvId(), policy.envId);
  for (const name of ['listFunctions', 'getFunctionDetail', 'invokeFunction', 'deleteFunction'])
    assert.equal(typeof manager.functions[name], 'function');
  assert.equal(typeof env.getAccessService().getAccessList, 'function');
  assert.equal(typeof env.getEnvService().describeHttpServiceRoute, 'function');
});

test('any raw run record, including corruption, is not proof of no website writes', async () => {
  for (const row of [{}, { state: 'FAILED' }, { state: 'SUCCEEDED' }]) {
    const f = await fixture();
    f.rawRun = row;
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
  const f = await fixture();
  f.options.readPreparationRun = async () => {
    throw Object.assign(Error('missing-or-corrupt'), { code: 'RUN_NOT_FOUND' });
  };
  await assert.rejects(recoverCatalogPreparation(f.options));
  assert.equal((await f.coordinator.status()).state, 'stalled');
});

test('wrong GitHub identity, unfinished or skipped jobs, and insufficient stopping time all keep the lock', async () => {
  const mutations = [
    (f) => {
      f.run.repository.full_name = 'other/channel';
    },
    (f) => {
      f.run.head_repository.id = 2;
    },
    (f) => {
      f.run.head_branch = 'main';
    },
    (f) => {
      f.run.event = 'push';
    },
    (f) => {
      f.run.path = '.github/workflows/deploy-test.yml';
    },
    (f) => {
      f.run.run_attempt = 2;
    },
    (f) => {
      f.job.head_sha = 'a'.repeat(40);
    },
    (f) => {
      f.job.status = 'in_progress';
    },
    (f) => {
      f.job.conclusion = 'skipped';
    },
    (f) => {
      f.job.name = 'other / site';
    },
    (f) => {
      f.job.completed_at = new Date(f.time.now() - 119999).toISOString();
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('uncertain cleanup, any delivery action or a remaining function prevents recovery', async () => {
  const mutations = [
    (f) => {
      f.regional.cleaned = false;
    },
    (f) => {
      f.regional.unconfirmed = true;
    },
    (f) => {
      f.regional.codeSha = 'a'.repeat(40);
    },
    (f) => {
      f.regional.functionName = 'admin';
    },
    (f) => {
      f.regional.environment = 'other';
    },
    (f) => {
      f.regional.runId = 'site-123-1';
    },
    (f) => {
      f.regional.created = false;
    },
    (f) => {
      f.regional.businessWrites = 1;
    },
    (f) => {
      f.regional.websiteWrites = 1;
    },
    (f) => {
      f.regional.calls.push({ requestId: 'write', action: 'delivery.begin', state: 'completed' });
    },
    (f) => {
      f.regional.calls[0].state = 'unconfirmed';
    },
    (f) => {
      f.names = [f.regional.functionName];
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('complete multi-page inventory may contain other apps, while duplicates across pages are rejected', async () => {
  const f = await fixture();
  f.names = Array.from({ length: 119 }, (_, index) => `unrelated-${index}`);
  const pages = [];
  const list = f.options.functions.listFunctions;
  f.options.functions.listFunctions = async (limit, offset) => {
    pages.push(offset);
    return list(limit, offset);
  };
  assert.equal((await recoverCatalogPreparation(f.options)).state, 'idle');
  assert.deepEqual(pages, [0, 100]);
  const duplicate = await fixture();
  duplicate.names = Array.from({ length: 101 }, (_, index) => `function-${index}`);
  duplicate.names[100] = 'function-0';
  await assert.rejects(recoverCatalogPreparation(duplicate.options));
  assert.equal((await duplicate.coordinator.status()).state, 'stalled');
});

test('live leases are untouched and every unresolved hosting marker blocks expired-lease recovery', async () => {
  const live = await fixture();
  live.time.advance(-180000);
  assert.equal((await recoverCatalogPreparation(live.options)).state, 'leased');
  assert.deepEqual(live.reads, []);
  for (const marker of ['currentRunId', 'dirtyRunId', 'unresolvedOperation', 'pendingStep']) {
    const f = await fixture();
    const status = await f.coordinator.status();
    f.options.coordinator = {
      ...f.coordinator,
      status: async () => ({
        ...status,
        target: {
          ...status.target,
          ...(marker !== 'pendingStep' ? { [marker]: 'unresolved' } : {}),
        },
        ...(marker === 'pendingStep' ? { pendingStep: { state: 'submitted' } } : {}),
      }),
    };
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.equal((await f.coordinator.status()).state, 'stalled');
    assert.deepEqual(f.reads, []);
  }
});

test('changed baseline or final transaction version races cannot release a newer state', async () => {
  for (const phase of ['evidence', 'transaction']) {
    const f = await fixture();
    if (phase === 'evidence') {
      f.options.loadEvidence = async () => {
        const key = `${f.coordinator.targetId}-site`;
        const row = f.store.inspect().find(([id]) => id === `scopes/${key}`)[1];
        const pointer = { ...row.baseline, activationId: 'b'.repeat(64) };
        f.store.replace('scopes', key, { ...row, active: pointer, baseline: pointer });
        return f.regional;
      };
    } else {
      const reconcile = f.coordinator.reconcile;
      f.options.coordinator = {
        ...f.coordinator,
        reconcile: async (input) => {
          const status = await f.coordinator.status();
          f.store.replace('targets', status.targetId, {
            ...status.target,
            version: status.target.version + 1,
          });
          return reconcile(input);
        },
      };
    }
    await assert.rejects(recoverCatalogPreparation(f.options));
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});

test('missing evidence, malformed function inventory and dirty hosting state never count as quiescent', async () => {
  for (const phase of ['evidence', 'inventory', 'dirty', 'second-raw-read']) {
    const f = await fixture();
    if (phase === 'evidence')
      f.options.loadEvidence = async () => {
        throw Error('PRIVATE_SIGNED_URL');
      };
    if (phase === 'inventory')
      f.options.functions.listFunctions = async () => [
        { FunctionName: 'duplicate' },
        { FunctionName: 'duplicate' },
      ];
    if (phase === 'dirty') {
      const status = await f.coordinator.status();
      f.store.replace('targets', status.targetId, {
        ...status.target,
        dirtyRunId: 'unconfirmed-site',
      });
    }
    if (phase === 'second-raw-read') {
      let reads = 0;
      f.options.readPreparationRun = async () =>
        ++reads === 1
          ? null
          : { _id: identity({ targetId: f.coordinator.targetId, runId: oldOwner }) };
    }
    const error = await recoverCatalogPreparation(f.options).catch((value) => value);
    assert(error instanceof Error);
    assert.equal(String(error).includes('PRIVATE_SIGNED_URL'), false);
    assert.equal((await f.coordinator.status()).state, 'stalled');
  }
});
