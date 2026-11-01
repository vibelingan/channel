import assert from 'node:assert/strict';
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
import { identity } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

const policy = {
  ...fixturePolicy,
  repository: 'vibelingan/channel',
  trustedRef: 'refs/heads/feat/seo-foundation',
  workflowPath: '.github/workflows/seo-static-canary.yml',
};
const oldRun = '41303614689';
const oldOwner = `site-${oldRun}-1`;
const codeSha = '4e517306715243341bbdfad93f0a1a9f29afb0e8';
async function fixture() {
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
