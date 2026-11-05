import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration } from './release-hosting-fixtures.mjs';
import { recoverStoppedCatalogDelivery } from './release/catalog-stopped-recovery.mjs';
import { hostingBatchBeforeHash, hostingBatchHash } from './release/hosting-batches.mjs';
import { identity, sha256 } from './release/input.mjs';
import { normalizePolicy } from './release/ledger.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { catalogRegionalReceiptId, catalogRegionalRequestHash } = tsxRequire(
  '../packages/db/src/catalog-seo-regional.ts',
  import.meta.url,
);
const { idleCatalogSeoControl } = tsxRequire(
  '../packages/db/src/catalog-seo-control.ts',
  import.meta.url,
);
const { catalogPublicRecordId } = tsxRequire(
  '../packages/db/src/catalog-public-changes.ts',
  import.meta.url,
);
const oldNumber = '41313740695';
const oldRunId = `site-${oldNumber}-1`;
const codeSha = 'c450903bb538915ace1fc01f7a1178376a308c40';
const targetId = normalizePolicy(policy).targetId;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-stopped-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T00:00:00Z');
  const time = new Date(now).toISOString();
  const files = new Map([
    ['index.html', Buffer.from('<h1>Home</h1>')],
    ['products/p-alpha/index.html', Buffer.from('<h1>Alpha</h1>')],
    ['products/p-beta/index.html', Buffer.from('<h1>Beta</h1>')],
  ]);
  const snapshot = {
    siteOrigin: policy.siteOrigin,
    products: [{ product: { _id: 'alpha' } }, { product: { _id: 'beta' } }],
  };
  const catalog = {
    schemaVersion: 1,
    siteOrigin: policy.siteOrigin,
    detailEnabled: true,
    writes: 17,
    headsSha256: 'e'.repeat(64),
    snapshotSha256: sha256(Buffer.from(JSON.stringify(snapshot))),
  };
  const payload = join(directory, 'candidate');
  createSitePayload({
    directory: payload,
    policy,
    configuration: configuration(),
    codeSha,
    releaseId: oldRunId,
    files,
    snapshot,
    catalog,
    now: now - 600000,
  });
  const input = siteArtifact({
    directory: payload,
    policy,
    now,
    run: {
      repository: policy.repository,
      workflowPath: policy.workflowPath,
      event: 'workflow_dispatch',
      ref: policy.trustedRef,
      headSha: codeSha,
      runId: oldNumber,
      artifact: {
        id: '123456',
        runId: oldNumber,
        expiresAt: '2027-01-01T00:00:00Z',
        expired: false,
      },
    },
  });
  const members = input.staticManifest.entries
    .filter((e) => e.path.startsWith('products/'))
    .map((e) => ({ ...e, beforeHash: 'a'.repeat(64) }));
  const afterHash = hostingBatchHash(members);
  const proof = {
    runnerRef: `github:${policy.repository}:${oldNumber}:attempt-1`,
    checkedAt: now - 120000,
    job: { status: 'completed', evidenceRef: 'authenticated-github-job' },
    cloud: {
      kind: 'stopped-site-html-batch',
      status: 'quiescent',
      operationId: 'pending-operation',
      observedHash: afterHash,
      evidenceRef: 'exact-original-batch',
    },
  };
  const run = {
    runId: oldRunId,
    targetId,
    scopeKey: 'site',
    kind: 'publish',
    state: 'FAILED',
    accepted: null,
    ownerRunId: oldRunId,
    fence: 27,
    acquiredVersion: 3491,
    deliveredComponents: ['static'],
    composition: { static: { releaseId: oldRunId, codeSha, artifact: input.envelope.artifact } },
    verifiedSteps: 35,
    verifiedWrites: 35,
    plan: { planSha256: 'c'.repeat(64), stepCount: 49 },
    reconciliation: proof,
  };
  const step = {
    _id: identity({ targetId, runId: oldRunId, stepId: 'pending-step' }),
    stepId: 'pending-step',
    runId: oldRunId,
    targetId,
    state: 'reconciled',
    component: 'static',
    kind: 'write',
    fence: 27,
    sequence: 35,
    operationId: 'pending-operation',
    intentHash: 'd'.repeat(64),
    planSha256: run.plan.planSha256,
    members,
    beforeHash: hostingBatchBeforeHash(members),
    afterHash,
    subject: `upload-batch:${afterHash}`,
    verifySubject: `read-batch:${afterHash}`,
    resolution: proof,
  };
  const status = {
    state: 'leased',
    targetId,
    pendingStep: null,
    target: {
      version: 4000,
      dirtyRunId: oldRunId,
      currentRunId: null,
      unresolvedOperation: null,
      lastReconciliation: proof,
      lease: {
        ownerRunId: 'site-41322701720-1',
        runnerRef: `github:${policy.repository}:41322701720:attempt-1`,
        fence: 29,
        acquiredVersion: 3998,
        expiresAt: now + 180000,
      },
    },
    scope: { scopeKey: 'site', baseline: { sourceRunId: 'accepted-A' }, version: 1 },
  };
  const githubRun = {
    id: Number(oldNumber),
    run_attempt: 1,
    repository: { id: 1, full_name: policy.repository },
    head_repository: { id: 1, full_name: policy.repository },
    head_sha: codeSha,
    head_branch: 'feat/seo-foundation',
    path: policy.workflowPath,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    updated_at: new Date(now - 180000).toISOString(),
  };
  const job = {
    id: 12345,
    run_id: Number(oldNumber),
    name: 'site_delivery / site',
    head_sha: codeSha,
    status: 'completed',
    conclusion: 'failure',
    started_at: new Date(now - 600000).toISOString(),
    completed_at: githubRun.updated_at,
  };
  const records = new Map();
  const evidence = {
    schemaVersion: 1,
    purpose: 'catalog-seo-regional-v1',
    runId: oldRunId,
    codeSha,
    functionName: `seo-catalog-region-${oldNumber}-1`,
    environment: policy.envId,
    created: true,
    cleaned: true,
    unconfirmed: false,
    websiteWrites: 0,
    businessWrites: 0,
    calls: [{ action: 'health', state: 'completed', requestId: 'health' }],
  };
  const hash = (action, requestId, input) =>
    catalogRegionalRequestHash({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      runId: oldRunId,
      targetId,
      siteOrigin: policy.siteOrigin,
      executorCodeSha: codeSha,
      requestId,
      guard: { targetId, ownerRunId: oldRunId, fence: 27, acquiredVersion: 3491 },
      action,
      input,
    });
  const addPair = (label, products, outcome = 'unknown') => {
    const ticket = {
      owner: `${oldRunId}:${label}`,
      fence: label === 'matched' ? 34 : 33,
      products,
    };
    for (const [action, requestId, body, result] of [
      [
        'delivery.begin',
        `begin-${label}`,
        { expectedWrites: 17, products, discovery: false },
        { ticket, expectedHeads: [] },
      ],
      ['delivery.end', `end-${label}`, { expectedWrites: 17, ticket, outcome }, { ended: true }],
    ]) {
      const _id = catalogRegionalReceiptId(oldRunId, requestId);
      records.set(_id, {
        _id,
        purpose: 'catalog-seo-regional-receipt',
        schemaVersion: 1,
        runId: oldRunId,
        requestId,
        action,
        inputHash: hash(action, requestId, body),
        result,
        completedAt: new Date(now - 200000).toISOString(),
      });
      evidence.calls.push({ action, requestId, state: 'completed' });
    }
  };
  addPair('matched', ['alpha', 'beta']);
  addPair('unrelated-later', ['other']);
  const f = {
    directory,
    now,
    files,
    run,
    step,
    status,
    input,
    githubRun,
    job,
    records,
    evidence,
    calls: [],
    progress: [],
    requests: [],
    clears: 0,
    idle: false,
    taskRows: [],
    statusReads: 0,
    hash,
    addPair,
  };
  f.options = {
    policy,
    now: () => f.now,
    coordinator: {
      targetId,
      status: async () => {
        f.statusReads++;
        return structuredClone(f.status);
      },
      runStatus: async (id) => {
        assert.equal(id, oldRunId);
        return structuredClone(f.run);
      },
    },
    regional: {
      recoverStoppedDeliveryStep: async (input) => {
        f.calls.push(input);
        const states = ['leased', 'writing', 'needs-readback', 'control'];
        const index = states.indexOf(input.state);
        const done = input.state === 'control';
        const released = done && !f.idle;
        if (done) {
          f.idle = true;
          f.clears++;
        }
        return {
          done,
          next: done ? null : { state: states[index + 1], cursor: null },
          releasedTasks: input.state === 'writing' && !f.idle ? 2 : 0,
          controlReleased: released,
        };
      },
    },
    github: {
      api: async (path) => {
        if (path === `/actions/runs/${oldNumber}/attempts/1`) return structuredClone(f.githubRun);
        assert.equal(path, `/actions/runs/${oldNumber}/attempts/1/jobs?per_page=100&page=1`);
        return { total_count: 1, jobs: [structuredClone(f.job)] };
      },
      get: async (path) => {
        const url = new URL(path, 'https://api.github.com');
        assert.equal(url.searchParams.get('ref'), codeSha);
        const file = url.pathname.replace(/^\/contents\//, '');
        const body = readFileSync(new URL(`../${file}`, import.meta.url));
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              type: 'file',
              path: file,
              encoding: 'base64',
              size: body.length,
              content: body.toString('base64'),
            }),
          ),
        };
      },
    },
    readSteps: async (id) => {
      assert.equal(id, oldRunId);
      return [structuredClone(f.step)];
    },
    readReceipt: async (id) => structuredClone(f.records.get(id) ?? null),
    loadCandidate: async (run) => {
      assert.equal(run.runId, oldRunId);
      return f.input;
    },
    loadEvidence: async (context) => {
      assert.equal(String(context.githubRun.id), oldNumber);
      assert.equal(context.artifactName, `site-delivery-evidence-${oldNumber}-1`);
      return structuredClone(f.evidence);
    },
    verifyQuiescence: async (context) => ({
      ...context,
      functionsAbsent: true,
      oldJobCompleted: true,
      checkedAt: f.now,
    }),
    request: async (method, url, options) => {
      assert.equal(method, 'GET');
      f.requests.push({ url, headers: options.headers });
      const path = new URL(url).pathname.slice(1).replace(/\/$/, '/index.html');
      const body = f.files.get(path);
      assert.ok(body);
      return {
        status: options.headers['if-none-match'] ? 304 : 200,
        headers: new Headers({
          etag: `"${path}"`,
          'cache-control': 'no-store',
          'content-type': 'text/html',
        }),
        body: options.headers['if-none-match'] ? Buffer.alloc(0) : body,
      };
    },
    readControl: async () =>
      f.idle
        ? idleCatalogSeoControl(policy.siteOrigin, time)
        : {
            ...idleCatalogSeoControl(policy.siteOrigin, time),
            state: 'needs-readback',
            owner: `${oldRunId}:matched`,
            until: time,
            fence: 34,
            products: ['alpha', 'beta'],
            writes: 17,
          },
    readTasks: async (state, cursor, limit) =>
      f.taskRows.filter((row) => row.state === state && row._id > (cursor ?? '')).slice(0, limit),
    onProgress: async (row) => f.progress.push(row),
  };
  return f;
}

async function refusesBeforeClear(f) {
  await assert.rejects(recoverStoppedCatalogDelivery(f.options));
  assert.equal(f.calls.length, 0);
}

test('no dirty run is a read-only no-op without candidate or receipt dependencies', async () => {
  const result = await recoverStoppedCatalogDelivery({
    coordinator: { status: async () => ({ target: { dirtyRunId: null } }) },
  });
  assert.equal(result.status, 'not-required');
  assert.deepEqual(result.stepIds, []);
});

test('generic lookup chooses the unique matching old pair and sealed writes, then clears in order', async (t) => {
  const f = fixture(t);
  const result = await recoverStoppedCatalogDelivery(f.options);
  assert.equal(result.status, 'recovered');
  assert.deepEqual(result.stepIds, ['pending-step']);
  assert.equal(result.beginRequestId, 'begin-matched');
  assert.equal(result.endRequestId, 'end-matched');
  assert.equal(result.originalWrites, 17);
  assert.equal(result.releasedTasks, 2);
  assert.equal(result.controlReleased, true);
  assert.deepEqual(
    f.calls.map((c) => c.state),
    ['leased', 'writing', 'needs-readback', 'control'],
  );
  assert.equal(f.requests.length, 6);
  assert.ok(
    f.calls.every(
      (c) => c.originalWrites === 17 && c.stepId === 'pending-step' && c.stoppedRunId === oldRunId,
    ),
  );
  assert.equal(f.run.state, 'FAILED');
  assert.equal(f.status.target.currentRunId, null);
  assert.equal(f.progress.at(-1).websiteWrites, 0);
});

test('already-cleared catalog state can be scanned again under a later guard after preparation cancellation', async (t) => {
  const f = fixture(t);
  await recoverStoppedCatalogDelivery(f.options);
  f.calls.length = 0;
  f.status.target.lease = {
    ...f.status.target.lease,
    ownerRunId: 'site-41322709999-1',
    runnerRef: `github:${policy.repository}:41322709999:attempt-1`,
    fence: 31,
    acquiredVersion: 4001,
  };
  f.status.target.version = 4002;
  f.status.target.lastReconciliation = {
    cloud: { kind: 'stopped-catalog-preparation-only' },
    inheritedReconciliation: {
      runId: oldRunId,
      proof: f.run.reconciliation,
      sha256: identity(f.run.reconciliation),
    },
  };
  const result = await recoverStoppedCatalogDelivery(f.options);
  assert.equal(result.status, 'recovered');
  assert.equal(result.controlReleased, false);
  assert.equal(f.calls.length, 4);
});

test('ordinary known failure skips only after control idle and no old in-flight leases are fully checked', async (t) => {
  const f = fixture(t);
  f.run.reconciliation = undefined;
  f.idle = true;
  f.options.loadCandidate = async () => {
    throw Error('must not download');
  };
  const result = await recoverStoppedCatalogDelivery(f.options);
  assert.equal(result.status, 'not-required-known-failure');
  assert.equal(f.calls.length, 0);
  f.idle = false;
  await refusesBeforeClear(f);
  f.idle = true;
  f.taskRows = [
    {
      _id: catalogPublicRecordId(policy.siteOrigin, 'alpha'),
      schemaVersion: 1,
      siteOrigin: policy.siteOrigin,
      productId: 'alpha',
      requestedSequence: 1,
      acceptedSequence: 0,
      state: 'writing',
      attempts: 1,
      lease: { runId: oldRunId, sequence: 1, until: new Date(f.now).toISOString() },
    },
  ];
  await refusesBeforeClear(f);
});

test('unknown or incomplete owner and old global evidence cannot clear anything', async (t) => {
  const changes = [
    (f) => {
      f.status.target.currentRunId = 'new-started-run';
    },
    (f) => {
      f.status.target.lease.fence = 0;
    },
    (f) => {
      f.status.target.lease.expiresAt = f.now;
    },
    (f) => {
      f.run.state = 'RUNNING';
    },
    (f) => {
      f.run.accepted = { sourceRunId: oldRunId };
    },
    (f) => {
      f.run.reconciliation.cloud.observedHash = 'a'.repeat(64);
    },
    (f) => {
      f.step.resolution = { other: true };
    },
    (f) => {
      f.step.state = 'unknown';
    },
    (f) => {
      f.step.members[0].path = 'index.html';
    },
    (f) => {
      f.options.readSteps = async () => Array.from({ length: 1000 }, () => f.step);
    },
    (f) => {
      f.githubRun.head_branch = 'main';
    },
    (f) => {
      f.job.status = 'in_progress';
    },
    (f) => {
      f.job.completed_at = new Date(f.now - 119999).toISOString();
    },
    (f) => {
      f.options.verifyQuiescence = async () => true;
    },
  ];
  for (const change of changes) {
    const f = fixture(t);
    change(f);
    await refusesBeforeClear(f);
  }
});

test('missing or ambiguous receipt pairs and wrong unknown-end hashes are rejected', async (t) => {
  const changes = [
    (f) => {
      f.records.delete(catalogRegionalReceiptId(oldRunId, 'begin-matched'));
    },
    (f) => {
      f.records.get(catalogRegionalReceiptId(oldRunId, 'end-matched')).inputHash = 'a'.repeat(64);
    },
    (f) => {
      f.records.get(catalogRegionalReceiptId(oldRunId, 'begin-matched')).runId = 'other';
    },
    (f) => {
      f.addPair('duplicate', ['alpha', 'beta']);
    },
    (f) => {
      f.evidence.cleaned = false;
    },
    (f) => {
      f.evidence.calls.push({ ...f.evidence.calls[1] });
    },
  ];
  for (const change of changes) {
    const f = fixture(t);
    change(f);
    await refusesBeforeClear(f);
  }
});

test('candidate corruption and changed public HTML refuse before recovery writes', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.input.directory, 'products/p-alpha/index.html'), 'corrupt');
  await refusesBeforeClear(f);
  const other = fixture(t);
  other.files.set('products/p-alpha/index.html', Buffer.from('changed live HTML'));
  await refusesBeforeClear(other);
});

test('each page permits this guard renewal but refuses a new owner or changed old proof', async (t) => {
  const f = fixture(t);
  const original = f.options.regional.recoverStoppedDeliveryStep;
  f.options.regional.recoverStoppedDeliveryStep = async (input) => {
    f.status.target.version++;
    f.status.target.lease.expiresAt += 1000;
    return original(input);
  };
  assert.equal((await recoverStoppedCatalogDelivery(f.options)).status, 'recovered');
  for (const mutate of [
    (f) => {
      f.status.target.lease.fence++;
    },
    (f) => {
      f.status.target.dirtyRunId = 'other';
    },
    (f) => {
      f.run.reconciliation = { other: true };
    },
  ]) {
    const f = fixture(t);
    const original = f.options.regional.recoverStoppedDeliveryStep;
    f.options.regional.recoverStoppedDeliveryStep = async (input) => {
      const result = await original(input);
      mutate(f);
      return result;
    };
    await assert.rejects(recoverStoppedCatalogDelivery(f.options), {
      code: 'CATALOG_STOPPED_RECOVERY_CHANGED',
    });
    assert.equal(f.calls.length, 1);
  }
});

test('malformed continuations and lost RPC completion stop without another page', async (t) => {
  for (const response of [
    {
      done: false,
      next: { state: 'control', cursor: null },
      releasedTasks: 0,
      controlReleased: false,
    },
    {
      done: false,
      next: { state: 'leased', cursor: null },
      releasedTasks: 0,
      controlReleased: false,
    },
    { done: true, next: null, releasedTasks: 0, controlReleased: false },
  ]) {
    const f = fixture(t);
    f.options.regional.recoverStoppedDeliveryStep = async (input) => {
      f.calls.push(input);
      return response;
    };
    await assert.rejects(recoverStoppedCatalogDelivery(f.options));
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(t);
  f.options.regional.recoverStoppedDeliveryStep = async (input) => {
    f.calls.push(input);
    throw Object.assign(Error('secret'), { code: 'CATALOG_REGIONAL_UNCONFIRMED' });
  };
  await assert.rejects(recoverStoppedCatalogDelivery(f.options), {
    code: 'CATALOG_REGIONAL_UNCONFIRMED',
  });
  assert.equal(f.calls.length, 1);
});

test('receipt request order is preserved while step membership is compared as the same product set', async (t) => {
  const f = fixture(t);
  f.step.members.reverse();
  f.step.afterHash = hostingBatchHash(f.step.members);
  f.step.beforeHash = hostingBatchBeforeHash(f.step.members);
  f.step.subject = `upload-batch:${f.step.afterHash}`;
  f.step.verifySubject = `read-batch:${f.step.afterHash}`;
  f.run.reconciliation.cloud.observedHash = f.step.afterHash;
  assert.equal((await recoverStoppedCatalogDelivery(f.options)).status, 'recovered');
});

test('a missing control record cannot prove a known failure clean', async (t) => {
  const f = fixture(t);
  f.run.reconciliation = undefined;
  f.options.readControl = async () => null;
  await refusesBeforeClear(f);
});
