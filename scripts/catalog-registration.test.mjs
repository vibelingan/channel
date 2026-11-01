import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  clock,
  composition,
  memoryStore,
  plan,
  policy,
  receipt,
  runner,
  stepInput,
} from './release-state-fixtures.mjs';
import { activateCatalogRenderer } from './release/catalog-activation.mjs';
import {
  completeCatalogRegistration,
  releaseStoppedCatalogRegistration,
} from './release/catalog-registration.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';
const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { articleSdkFixture } = tsxRequire(
  '../packages/db/src/article-sdk-fixture.test-helper.ts',
  import.meta.url,
);
const { createCatalogSeoStore } = tsxRequire(
  '../packages/db/src/catalog-seo-cloud.ts',
  import.meta.url,
);
const { createCatalogAcceptanceProof, prepareCatalogAcceptance } = tsxRequire(
  './catalog-acceptance.ts',
  import.meta.url,
);
const { prepareCatalogRefresh } = tsxRequire('./catalog-refresh.ts', import.meta.url);
const { consumeCatalogSeoRequest } = tsxRequire(
  '../packages/db/src/catalog-seo-consumer.ts',
  import.meta.url,
);
const { createCatalogSeoRequest } = tsxRequire(
  '../packages/db/src/catalog-seo-requests.ts',
  import.meta.url,
);
const { catalogSeoControlId, idleCatalogSeoControl, planCatalogSeoWrite, writeCatalogSeoPermit } =
  tsxRequire('../packages/db/src/catalog-seo-control.ts', import.meta.url);
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const sdkRequire = createRequire(dbRequire.resolve('@cloudbase/node-sdk/package.json'));

async function sdkFixture(t) {
  const f = articleSdkFixture(t);
  const originalRequest = f.db.constructor.reqClass;
  const offlineRequest = sdkRequire('@cloudbase/database').Db.reqClass;
  assert.equal(offlineRequest.name, 'Request');
  f.db.constructor.reqClass = offlineRequest;
  t.after(() => {
    f.db.constructor.reqClass = originalRequest;
  });
  const time = clock();
  const sourcePolicy = { ...policy, envId: f.db.config.env };
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db: f.db, envId: sourcePolicy.envId }),
    policy: sourcePolicy,
    clock: time.now,
  });
  const runId = 'site-123-1';
  const owner = { ownerRunId: runId, runnerRef: 'github:fixture/channel:123:attempt-1' };
  const guard = await coordinator.acquire(owner);
  await coordinator.startRun({
    guard,
    runId,
    scopeKey: 'site',
    kind: 'adopt',
    composition: composition('A'),
    plan: plan(1),
  });
  const step = await coordinator.beginStep({ guard, runId, ...stepInput('accept') });
  await coordinator.confirmStep({ guard, runId, stepId: step.stepId, receipt: receipt(step) });
  await coordinator.commitRun({ guard, runId, changeSetRef: 'accepted original site' });
  const run = await coordinator.runStatus(runId);
  const input = {
    envelope: { artifact: run.composition.static.artifact },
    acceptedSeal: run.accepted.seals.static,
  };
  return {
    ...f,
    coordinator,
    time,
    runId,
    input,
    owner,
    targetId: guard.targetId,
    store: createCatalogSeoStore(f.db),
    now: time.now,
  };
}

const activate = (f, { writeActive }, finishCatalog = async () => {}) =>
  activateCatalogRenderer({
    db: f.db,
    proof: { codeSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) },
    runId: f.runId,
    executorSha: 'c'.repeat(40),
    executorRef: 'feat/seo-foundation',
    finishCatalog,
    writeActive,
  });

test('accepted registration interrupted before another product save is cleaned without accepting old HTML, then refresh runs', async (t) => {
  const f = await sdkFixture(t);
  const config = { siteOrigin: policy.siteOrigin, detailEnabled: true };
  const time = new Date(f.time.now()).toISOString();
  const controlId = catalogSeoControlId(config.siteOrigin);
  f.put('catalogSeoControl', controlId, idleCatalogSeoControl(config.siteOrigin, time));
  for (const id of ['p1', 'p2']) {
    f.put('products', id, { name: `Original ${id}`, published: true, productFamily: 'misc' });
    const request = createCatalogSeoRequest(
      config.siteOrigin,
      { kind: 'product', productId: id, previouslyPublic: true },
      time,
    );
    f.put('catalogSeoRequests', request._id, request);
    await consumeCatalogSeoRequest(f.store, request, config, time);
  }
  const heads = await f.store.list(
    'catalogPublicHeads',
    { siteOrigin: config.siteOrigin },
    null,
    100,
  );
  const snapshot = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'public',
      siteOrigin: config.siteOrigin,
      products: heads.map((head) => ({
        product: { _id: head.productId },
        publicVersion: {
          sequence: head.sequence,
          semanticHash: head.semanticHash,
          changedAt: head.changedAt,
        },
      })),
    }),
  );
  const proof = createCatalogAcceptanceProof({ config, snapshot, capture: { writes: 0, heads } });
  const initial = await prepareCatalogAcceptance({
    store: f.store,
    proof,
    snapshot,
    runId: f.runId,
  });
  await initial.delivery.begin(['p1']); // Persistent DB state left by the stopped registrar.
  const request = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p2', previouslyPublic: true },
    time,
  );
  await f.store.transaction(async (tx) => {
    const before = await tx.get('products', 'p2');
    const after = { ...before, name: 'Customer updated the other product' };
    const permit = await planCatalogSeoWrite(
      tx,
      config,
      [{ collection: 'products', before, after }],
      [request],
      time,
    );
    await tx.set('products', after);
    await tx.set('catalogSeoRequests', request);
    await writeCatalogSeoPermit(tx, permit);
  });
  assert.equal(f.rows.get(`catalogSeoControl/${controlId}`).state, 'writing');
  assert.equal(f.rows.get(`catalogSeoControl/${controlId}`).writes, 1);
  const previousHeads = structuredClone(
    await f.store.list('catalogPublicHeads', { siteOrigin: config.siteOrigin }, null, 100),
  );
  const callsBeforeCleanup = f.calls.length;
  await assert.rejects(
    completeCatalogRegistration({
      ...f,
      register: ({ run: acceptedRun, checkpoint, checkTransaction }) =>
        prepareCatalogAcceptance({
          store: f.store,
          proof,
          snapshot,
          runId: f.runId,
          acceptedRun,
          checkpoint,
          checkTransaction,
        }),
    }),
    /New product requests|Products changed/,
  );
  const cleanupWrite = f.calls
    .slice(callsBeforeCleanup)
    .find(
      (call) =>
        call.api === 'database.modifyDocument' && call.params.collectionName === 'catalogSeoTasks',
    );
  assert(cleanupWrite);
  for (const collectionName of ['siteReleaseTargets', 'siteReleaseScopes'])
    assert(
      f.calls.some(
        (call) =>
          call.api === 'database.getDocument' &&
          call.params.collectionName === collectionName &&
          call.params.transactionId === cleanupWrite.params.transactionId,
      ),
    );
  assert.equal(f.rows.get(`catalogSeoControl/${controlId}`).state, 'idle');
  assert.equal(f.rows.get(`catalogSeoControl/${controlId}`).writes, 1);
  assert.deepEqual(
    await f.store.list('catalogPublicHeads', { siteOrigin: config.siteOrigin }, null, 100),
    previousHeads,
  );
  assert.deepEqual(f.rows.get(`catalogSeoRequests/${request._id}`), request);
  assert.equal(f.rows.get('products/p2').name, 'Customer updated the other product');
  assert.equal(f.rows.has('catalogSeoBuilders/active'), false);
  for (const head of heads) {
    const task = f.rows.get(`catalogSeoTasks/${head._id}`);
    assert.equal(task.acceptedSequence, 0);
    assert.equal(task.lease, null);
  }
  const refreshed = await prepareCatalogRefresh(f.store, config, 'site-999-1');
  assert.equal(refreshed.writes, 1);
  assert.equal(refreshed.heads.find((head) => head.productId === 'p2').sequence, 2);
  const ticket = await refreshed.delivery.begin(['p1', 'p2']);
  await refreshed.delivery.end(ticket, 'verified');
});

test('the actual activation writes active in the same installed-SDK transaction that checks site lease and baseline', async (t) => {
  const f = await sdkFixture(t);
  await completeCatalogRegistration({ ...f, register: (guarded) => activate(f, guarded) });
  assert.equal(f.rows.get('catalogSeoBuilders/active').acceptedRunId, f.runId);
  const write = f.calls.find(
    (call) =>
      call.api === 'database.modifyDocument' && call.params.collectionName === 'catalogSeoBuilders',
  );
  assert(write);
  for (const collectionName of ['siteReleaseTargets', 'siteReleaseScopes'])
    assert(
      f.calls.some(
        (call) =>
          call.api === 'database.getDocument' &&
          call.params.collectionName === collectionName &&
          call.params.transactionId === write.params.transactionId,
      ),
    );
});

test('lease expiry during the final catalog check prevents the real activation from writing active', async (t) => {
  const f = await sdkFixture(t);
  await assert.rejects(
    completeCatalogRegistration({
      ...f,
      register: (guarded) =>
        activate(f, guarded, async () => {
          f.time.advance(180001);
        }),
    }),
  );
  assert.equal(f.rows.has('catalogSeoBuilders/active'), false);
});

test('lease expiry after the prewrite checkpoint is rejected by the activation transaction', async (t) => {
  const f = await sdkFixture(t);
  const store = {
    ...f.store,
    transaction: async (operation) => {
      f.time.advance(180001);
      return f.store.transaction(operation);
    },
  };
  await assert.rejects(
    completeCatalogRegistration({ ...f, store, register: (guarded) => activate(f, guarded) }),
    /current accepted/,
  );
  assert.equal(f.rows.has('catalogSeoBuilders/active'), false);
});

test('a baseline change before SDK transaction commit rolls back the real active-pointer write', async (t) => {
  const f = await sdkFixture(t);
  const key = `${f.targetId}-site`;
  const store = {
    ...f.store,
    transaction: async (operation) =>
      f.store.transaction(async (tx) => {
        await operation(tx);
        f.control.beforeCommit = () => {
          f.control.beforeCommit = undefined;
          const scope = f.rows.get(`siteReleaseScopes/${key}`);
          f.put('siteReleaseScopes', key, {
            ...scope,
            active: { ...scope.active, sourceRunId: 'newer-site' },
            baseline: { ...scope.baseline, sourceRunId: 'newer-site' },
          });
        };
      }),
  };
  await assert.rejects(
    completeCatalogRegistration({ ...f, store, register: (guarded) => activate(f, guarded) }),
  );
  assert.equal(f.rows.has('catalogSeoBuilders/active'), false);
});

async function fixture() {
  const time = clock();
  const coordinator = createReleaseCoordinator({ store: memoryStore(), policy, clock: time.now });
  const runId = 'site-123-1';
  const guard = await coordinator.acquire(runner(runId));
  await coordinator.startRun({
    guard,
    runId,
    scopeKey: 'site',
    kind: 'adopt',
    composition: composition('A'),
    plan: plan(1),
  });
  const step = await coordinator.beginStep({ guard, runId, ...stepInput('accept') });
  await coordinator.confirmStep({ guard, runId, stepId: step.stepId, receipt: receipt(step) });
  await coordinator.commitRun({ guard, runId, changeSetRef: 'original accepted site' });
  const accepted = await coordinator.runStatus(runId);
  const input = {
    envelope: { artifact: accepted.composition.static.artifact },
    acceptedSeal: accepted.accepted.seals.static,
  };
  return { coordinator, runId, input, time, owner: runner('catalog-registration') };
}

test('a stopped DB-only registrar can be released after its real owner ended without changing the accepted site', async () => {
  const f = await fixture();
  const owner = { ownerRunId: 'readback-456-1', runnerRef: 'github:fixture/channel:456:attempt-1' };
  await f.coordinator.acquire(owner);
  const run = await f.coordinator.runStatus(f.runId);
  const jobProof = {
    status: 'completed',
    runnerRef: owner.runnerRef,
    evidenceRef: 'github:456:attempt-1:completed',
  };
  await assert.rejects(
    releaseStoppedCatalogRegistration({ ...f, run, jobProof, now: f.time.now }),
    /current accepted/,
  );
  f.time.advance(180001);
  await assert.rejects(
    releaseStoppedCatalogRegistration({
      ...f,
      run,
      jobProof: { ...jobProof, status: 'in_progress' },
      now: f.time.now,
    }),
    /not confirmed/,
  );
  await releaseStoppedCatalogRegistration({ ...f, run, jobProof, now: f.time.now });
  const after = await f.coordinator.status();
  assert.equal(after.target.lease, null);
  assert.equal(after.scope.baseline.sourceRunId, f.runId);
  assert.equal((await f.coordinator.runStatus(f.runId)).state, 'SUCCEEDED');
  await completeCatalogRegistration({ ...f, register: async () => ({ complete: true }) });
});

test('interrupted catalog registration releases only its metadata lease and can be retried', async () => {
  const f = await fixture();
  let attempts = 0;
  const register = async ({ checkpoint }) => {
    await checkpoint();
    attempts++;
    if (attempts === 1) throw Error('DB registration interrupted');
    return { acceptedRunId: f.runId };
  };
  await assert.rejects(completeCatalogRegistration({ ...f, register }), /interrupted/);
  assert.equal((await f.coordinator.status()).state, 'idle');
  assert.deepEqual(await completeCatalogRegistration({ ...f, register }), {
    acceptedRunId: f.runId,
  });
  const after = await f.coordinator.status();
  assert.equal(after.scope.baseline.sourceRunId, f.runId);
  assert.equal(after.target.dirtyRunId, null);
  assert.equal(after.target.lease, null);
});

test('an older accepted website cannot overwrite the current catalog program registration', async () => {
  const f = await fixture();
  const guard = await f.coordinator.acquire(runner('new-site'));
  await f.coordinator.startRun({
    guard,
    runId: 'new-site',
    scopeKey: 'site',
    kind: 'publish',
    composition: composition('B'),
    deliveredComponents: ['static'],
    plan: plan(1),
  });
  const step = await f.coordinator.beginStep({ guard, runId: 'new-site', ...stepInput('accept') });
  await f.coordinator.confirmStep({
    guard,
    runId: 'new-site',
    stepId: step.stepId,
    receipt: receipt(step),
  });
  await f.coordinator.commitRun({ guard, runId: 'new-site', changeSetRef: 'new accepted site' });
  let called = false;
  await assert.rejects(
    completeCatalogRegistration({
      ...f,
      register: async () => {
        called = true;
      },
    }),
    /current accepted/,
  );
  assert.equal(called, false);
});

test('a pending upload remains blocked and catalog registration never resolves it', async () => {
  const f = await fixture();
  const guard = await f.coordinator.acquire(runner('new-site'));
  await f.coordinator.startRun({
    guard,
    runId: 'new-site',
    scopeKey: 'site',
    kind: 'publish',
    composition: composition('B'),
    deliveredComponents: ['static'],
    plan: plan(2),
  });
  const step = await f.coordinator.beginStep({ guard, runId: 'new-site', ...stepInput('write') });
  await f.coordinator.markUnknown({
    guard,
    runId: 'new-site',
    stepId: step.stepId,
    reason: 'unconfirmed PUT',
  });
  let called = false;
  await assert.rejects(
    completeCatalogRegistration({
      ...f,
      register: async () => {
        called = true;
      },
    }),
    /current accepted/,
  );
  assert.equal(called, false);
  assert.equal((await f.coordinator.status()).pendingStep.operationId, step.operationId);
});

test('a baseline change during registration is caught at its checkpoint before the next catalog write', async () => {
  const f = await fixture();
  let reads = 0;
  const coordinator = {
    ...f.coordinator,
    status: async (...args) => {
      const current = await f.coordinator.status(...args);
      if (++reads >= 3)
        return {
          ...current,
          scope: {
            ...current.scope,
            baseline: { ...current.scope.baseline, sourceRunId: 'newer-site' },
          },
        };
      return current;
    },
  };
  let writes = 0;
  await assert.rejects(
    completeCatalogRegistration({
      ...f,
      coordinator,
      register: async ({ checkpoint }) => {
        await checkpoint();
        writes++;
      },
    }),
    /current accepted/,
  );
  assert.equal(writes, 0);
  assert.equal((await f.coordinator.status()).target.lease, null);
});
