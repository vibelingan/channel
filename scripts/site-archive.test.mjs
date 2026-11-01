import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { configuration } from './release-hosting-fixtures.mjs';
import { clock, memoryStore, plan, receipt, stepInput } from './release-state-fixtures.mjs';
import { createCosArchiveTransfer } from './release/cos-archive-transfer.mjs';
import { createGithubReadClient } from './release/github-read.mjs';
import { sha256 } from './release/input.mjs';
import { createPrivateArchive } from './release/private-archive.mjs';
import {
  archiveAcceptedSite,
  assertSiteArchiveInvocation,
  createSiteArchiveDiagnostic,
} from './release/site-archive.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
import { SITE_DELIVERY_POLICY as livePolicy } from './release/site-policy.mjs';
import { createSiteRetention } from './release/site-retention.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

const policy = {
  repository: 'fixture/channel',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
  workflowPath: '.github/workflows/seo-static-canary.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
};
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'site-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'original');
  const codeSha = 'a'.repeat(40);
  createSitePayload({
    directory,
    policy,
    configuration: configuration(),
    codeSha,
    releaseId: 'site-101-1',
    files: new Map([
      ['index.html', Buffer.from('<main>Customer page</main>')],
      ['errors/not-found.html', Buffer.from('<h1>Not found</h1>')],
    ]),
    snapshot: { siteOrigin: policy.siteOrigin, products: [] },
    blogDelivery: 'server',
  });
  const metadata = {
    repository: policy.repository,
    workflowPath: policy.workflowPath,
    event: 'workflow_dispatch',
    ref: policy.trustedRef,
    headSha: codeSha,
    runId: '101',
    artifact: {
      id: '111',
      runId: '101',
      expired: false,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };
  const input = siteArtifact({ directory, policy, run: metadata });
  const ledger = memoryStore();
  const time = clock();
  const coordinator = createReleaseCoordinator({ store: ledger, policy, clock: time.now });
  const guard = await coordinator.acquire({
    ownerRunId: 'site-101-1',
    runnerRef: 'github:fixture/channel:101:attempt-1',
  });
  await coordinator.startRun({
    guard,
    runId: 'site-101-1',
    scopeKey: 'site',
    kind: 'adopt',
    plan: plan(1),
    composition: {
      static: {
        releaseId: input.envelope.releaseId,
        codeSha,
        contentSha256: 'b'.repeat(64),
        artifact: input.envelope.artifact,
      },
    },
  });
  const step = await coordinator.beginStep({ guard, runId: 'site-101-1', ...stepInput('accept') });
  await coordinator.confirmStep({
    guard,
    runId: 'site-101-1',
    stepId: step.stepId,
    receipt: receipt(step),
  });
  await coordinator.commitRun({ guard, runId: 'site-101-1', changeSetRef: 'accepted source' });
  const records = new Map();
  const blobs = new Map();
  const calls = [];
  const db = {
    collection(name) {
      assert.equal(name, 'catalogSeoArchives', 'No business collection may be accessed');
      return {
        doc(id) {
          return {
            get: async () => ({ data: records.has(id) ? [{ ...records.get(id), _id: id }] : [] }),
            set: async (data) => {
              records.set(id, structuredClone(data));
              calls.push('register');
              return { id };
            },
          };
        },
      };
    },
  };
  const objects = {
    async put(bytes) {
      calls.push('put');
      const hash = sha256(bytes);
      const ref = {
        fileID: `cloud://fixture-env.bucket/seo-recovery/objects/${hash}.bin`,
        sha256: hash,
        bytes: bytes.length,
      };
      blobs.set(ref.fileID, Buffer.from(bytes));
      return ref;
    },
    async get(ref) {
      calls.push('get');
      const body = blobs.get(ref.fileID);
      if (!body) throw Error('Missing object');
      return Buffer.from(body);
    },
  };
  const retention = createSiteRetention({ db, objects, policy });
  const source = {
    async download(id, destination, options) {
      assert.equal(id, '111');
      assert.equal(options.acceptedRunId, '101');
      calls.push('download');
      cpSync(directory, destination, { recursive: true });
      return metadata;
    },
  };
  const file = join(root, 'receipt.json');
  const diagnostic = createSiteArchiveDiagnostic({ file });
  const options = {
    coordinator,
    source,
    retention,
    policy,
    directory: join(root, 'work'),
    owner: { ownerRunId: 'site-archive-999-1', runnerRef: 'github:fixture/channel:999:attempt-1' },
    observe: diagnostic.observe,
    now: time.now,
  };
  return {
    root,
    time,
    db,
    ledger,
    coordinator,
    objects,
    source,
    retention,
    records,
    blobs,
    calls,
    file,
    diagnostic,
    options,
  };
}

async function stoppedArchive(t) {
  const f = await fixture(t);
  await f.coordinator.acquire({
    ownerRunId: 'site-archive-456-1',
    runnerRef: 'github:fixture/channel:456:attempt-1',
  });
  f.time.advance(180001);
  const run = {
    id: 456,
    run_attempt: 1,
    event: 'workflow_dispatch',
    path: policy.workflowPath,
    head_branch: policy.trustedRef.slice(11),
    head_sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'timed_out',
    repository: { full_name: policy.repository },
    head_repository: { full_name: policy.repository },
  };
  const job = {
    id: 876,
    run_id: 456,
    head_sha: run.head_sha,
    name: 'site_archive',
    status: 'completed',
    conclusion: 'timed_out',
    started_at: '2026-10-21T00:00:00Z',
    completed_at: '2026-10-21T00:02:59Z',
  };
  const definition = {
    on: { workflow_dispatch: { inputs: { mode: { options: ['site-archive'] } } } },
    jobs: {
      site_archive: {
        if: "${{ github.ref == 'refs/heads/feat/seo-foundation' && inputs.mode == 'site-archive' }}",
        environment: 'test',
        steps: [{ run: './apps/site/node_modules/.bin/tsx scripts/archive-accepted-site.ts' }],
      },
    },
  };
  const reads = [];
  const beforeRead = { run: () => {}, jobs: () => {}, source: () => {} };
  const github = createGithubReadClient({
    policy,
    token: 'fixture-token',
    request: async (method, url) => {
      assert.equal(method, 'GET');
      const path = new URL(url).pathname.replace(`/repos/${policy.repository}`, '');
      reads.push(path);
      let answer;
      if (path === '/actions/runs/456/attempts/1') {
        await beforeRead.run();
        answer = run;
      } else if (path === '/actions/runs/456/attempts/1/jobs') {
        await beforeRead.jobs();
        answer = { total_count: 1, jobs: [job] };
      } else if (path === `/contents/${policy.workflowPath}`) {
        await beforeRead.source();
        const bytes = Buffer.from(JSON.stringify(definition));
        answer = {
          type: 'file',
          path: policy.workflowPath,
          encoding: 'base64',
          size: bytes.length,
          content: bytes.toString('base64'),
        };
      } else throw Error(`Unexpected fixture API path: ${path}`);
      return { status: 200, body: Buffer.from(JSON.stringify(answer)) };
    },
  });
  return { ...f, run, job, definition, reads, beforeRead, options: { ...f.options, github } };
}

test('a killed archive-only job is taken over only after exact terminal GitHub and source proof, preserving its accepted site', async (t) => {
  const f = await stoppedArchive(t);
  const before = (await f.coordinator.status()).scope.baseline;
  assert.equal((await f.coordinator.status()).state, 'stalled');
  await archiveAcceptedSite(f.options);
  const after = await f.coordinator.status();
  assert.equal(after.state, 'idle');
  assert.deepEqual(after.scope.baseline, before);
  assert.equal(after.target.lastReconciliation.cloud.kind, 'stopped-site-archive-only');
  assert.equal(after.target.lastReconciliation.cloud.operationId, null);
  assert.equal(after.target.lastReconciliation.cloud.observedHash, null);
  assert.deepEqual(f.reads, [
    '/actions/runs/456/attempts/1',
    '/actions/runs/456/attempts/1/jobs',
    `/contents/${policy.workflowPath}`,
  ]);
  assert.equal(f.records.size, 1);
  assert.equal(JSON.parse(readFileSync(f.file)).status, 'complete');
});

for (const [label, patch] of [
  [
    'unfinished workflow',
    (f) => {
      f.run.status = 'in_progress';
      f.run.conclusion = null;
    },
  ],
  [
    'different attempt',
    (f) => {
      f.run.run_attempt = 2;
    },
  ],
  [
    'foreign repository',
    (f) => {
      f.run.head_repository.full_name = 'foreign/channel';
    },
  ],
  [
    'automatic workflow',
    (f) => {
      f.run.event = 'push';
    },
  ],
  [
    'other branch',
    (f) => {
      f.run.head_branch = 'test';
    },
  ],
  [
    'unfinished archive job',
    (f) => {
      f.job.status = 'in_progress';
      f.job.conclusion = null;
    },
  ],
  [
    'skipped archive job from another mode',
    (f) => {
      f.job.conclusion = 'skipped';
    },
  ],
  [
    'wrong job',
    (f) => {
      f.job.name = 'site_delivery';
    },
  ],
  [
    'wrong job SHA',
    (f) => {
      f.job.head_sha = 'b'.repeat(40);
    },
  ],
  [
    'source without archive-only condition',
    (f) => {
      f.definition.jobs.site_archive.if = '${{ always() }}';
    },
  ],
  [
    'source with another command',
    (f) => {
      f.definition.jobs.site_archive.steps[0].run = 'node scripts/deploy-cloudbase-test.mjs';
    },
  ],
])
  test(`${label} cannot release an archive lock`, async (t) => {
    const f = await stoppedArchive(t);
    patch(f);
    await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
    const status = await f.coordinator.status();
    assert.equal(status.state, 'stalled');
    assert.equal(status.target.lease.ownerRunId, 'site-archive-456-1');
    assert.deepEqual(f.calls, []);
  });

test('another owner and a live archive lease are never released by this entry', async (t) => {
  const f = await stoppedArchive(t);
  const status = await f.coordinator.status();
  f.ledger.replace('targets', status.targetId, {
    ...status.target,
    lease: { ...status.target.lease, ownerRunId: 'site-456-1' },
  });
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.deepEqual(f.reads, []);
  assert.equal((await f.coordinator.status()).target.lease.ownerRunId, 'site-456-1');
});

test('an unexpired archive lease or mismatched runner identity never uses GitHub takeover proof', async (t) => {
  const f = await stoppedArchive(t);
  const status = await f.coordinator.status();
  f.ledger.replace('targets', status.targetId, {
    ...status.target,
    lease: { ...status.target.lease, expiresAt: f.time.now() + 60000 },
  });
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.deepEqual(f.reads, []);
  f.ledger.replace('targets', status.targetId, {
    ...status.target,
    lease: { ...status.target.lease, runnerRef: 'github:fixture/channel:789:attempt-1' },
  });
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.deepEqual(f.reads, []);
});

for (const kind of ['pending', 'dirty'])
  test(`a real ${kind} hosting operation cannot be cleared as archive-only work`, async (t) => {
    const f = await stoppedArchive(t);
    f.time.advance(-180001);
    const status = await f.coordinator.status();
    const guard = {
      targetId: status.targetId,
      ownerRunId: status.target.lease.ownerRunId,
      fence: status.target.lease.fence,
      acquiredVersion: status.target.lease.acquiredVersion,
    };
    const source = await f.coordinator.runStatus('site-101-1');
    await f.coordinator.startRun({
      guard,
      runId: 'site-456-1',
      scopeKey: 'site',
      kind: 'publish',
      composition: source.composition,
      plan: plan(2),
      deliveredComponents: ['static'],
    });
    const step = await f.coordinator.beginStep({
      guard,
      runId: 'site-456-1',
      ...stepInput('write'),
    });
    if (kind === 'dirty') {
      await f.coordinator.confirmStep({
        guard,
        runId: 'site-456-1',
        stepId: step.stepId,
        receipt: receipt(step),
      });
      await f.coordinator.failRun({ guard, runId: 'site-456-1', reason: 'known hosting failure' });
    }
    f.time.advance(180001);
    await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
    const after = await f.coordinator.status();
    assert.equal(after.state, 'stalled');
    assert.equal(after.target.lease.ownerRunId, 'site-archive-456-1');
    assert(after.target.unresolvedOperation || after.target.dirtyRunId);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.calls, []);
  });

test('a renewed version or changed baseline during GitHub checks cannot be reconciled', async (t) => {
  const f = await stoppedArchive(t);
  f.beforeRead.source = async () => {
    const status = await f.coordinator.status();
    f.ledger.replace('targets', status.targetId, {
      ...status.target,
      version: status.target.version + 1,
    });
  };
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.equal((await f.coordinator.status()).state, 'stalled');
  assert.deepEqual(f.calls, []);
});

test('the existing coordinator transaction rejects a version race after the final takeover check', async (t) => {
  const f = await stoppedArchive(t);
  const reconcile = f.coordinator.reconcile;
  const coordinator = {
    ...f.coordinator,
    reconcile: async (input) => {
      const status = await f.coordinator.status();
      f.ledger.replace('targets', status.targetId, {
        ...status.target,
        version: status.target.version + 1,
      });
      return reconcile(input);
    },
  };
  await assert.rejects(archiveAcceptedSite({ ...f.options, coordinator }), /SITE_ARCHIVE_FAILED/);
  assert.equal((await f.coordinator.status()).state, 'stalled');
  assert.deepEqual(f.calls, []);
});

test('a baseline replacement during proof reads remains intact and prevents takeover', async (t) => {
  const f = await stoppedArchive(t);
  f.beforeRead.source = async () => {
    const status = await f.coordinator.status();
    const key = `${status.targetId}-site`;
    const scope = f.ledger.inspect().find(([id]) => id === `scopes/${key}`)[1];
    const pointer = { ...scope.baseline, activationId: 'changed-during-proof' };
    f.ledger.replace('scopes', key, { ...scope, active: pointer, baseline: pointer });
  };
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  const after = await f.coordinator.status();
  assert.equal(after.scope.baseline.activationId, 'changed-during-proof');
  assert.equal(after.state, 'stalled');
  assert.deepEqual(f.calls, []);
});

test('archives the current sealed site through real retention packaging and full readback without website ports', async (t) => {
  const f = await fixture(t);
  const result = await archiveAcceptedSite(f.options);
  assert.equal(result.sourceRunId, 'site-101-1');
  assert.equal(result.websiteWrites, 0);
  assert.equal(result.businessWrites, 0);
  assert.deepEqual(f.calls, ['download', 'put', 'get', 'register', 'get']);
  assert.equal(f.records.size, 1);
  assert.equal((await f.coordinator.status()).state, 'idle');
  assert.equal((await f.coordinator.status()).scope.baseline.sourceRunId, 'site-101-1');
  const record = JSON.parse(readFileSync(f.file));
  assert.equal(record.status, 'complete');
  assert(record.events.some((event) => event.stage === 'archive-verified'));
});

test('archive-only execution also passes through the installed COS HTTP client and the existing private archive validator', async (t) => {
  const f = await fixture(t);
  const COS = createRequire(import.meta.url)('cos-nodejs-sdk-v5');
  const stored = new Map();
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req.method);
    const key = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.headers['x-cos-acl'], undefined);
      assert.equal(req.headers['cache-control'], 'private, no-store');
      assert.equal(req.headers['x-cos-meta-fileid'], 'fixture-meta');
      stored.set(key, Buffer.concat(chunks));
      res.setHeader('etag', '"fixture"');
      return res.end();
    }
    const bytes = stored.get(key);
    if (!bytes) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('etag', '"fixture"');
    res.setHeader('content-length', bytes.length);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const storagePolicy = {
    ...policy,
    archiveBucket: 'fixture-env-1234567890',
    region: 'ap-shanghai',
  };
  const cos = new COS({
    SecretId: 'fixture',
    SecretKey: 'fixture',
    Protocol: 'http:',
    Domain: `127.0.0.1:${server.address().port}`,
    ConfCwd: join(f.root, 'cos'),
  });
  const objects = createPrivateArchive({
    ...createCosArchiveTransfer({
      cos,
      policy: storagePolicy,
      onStatus: (event) => f.diagnostic.observe({ kind: 'sdk', ...event }),
    }),
    policy: storagePolicy,
    sdk: {
      getUploadMetadata: async ({ cloudPath }) => ({
        data: {
          url: `https://${storagePolicy.archiveBucket}.cos.ap-shanghai.myqcloud.com/${cloudPath}`,
          fileId: `cloud://fixture-env.${storagePolicy.archiveBucket}/${cloudPath}`,
          cosFileId: 'fixture-meta',
          authorization: 'fixture-authorization',
          token: 'fixture-token',
        },
      }),
    },
    manager: {
      permission: {
        describeResourcePermission: async () => ({
          Data: {
            PermissionList: [
              {
                Resource: storagePolicy.archiveBucket,
                ResourceType: 'storage',
                Permission: 'PRIVATE',
              },
            ],
          },
        }),
      },
    },
    readLifecycle: async () => ({ Rules: [] }),
    onTransfer: (event) => f.diagnostic.observe({ kind: 'transfer', ...event }),
  });
  const retention = createSiteRetention({ db: f.db, objects, policy });
  await archiveAcceptedSite({ ...f.options, retention });
  assert.equal(requests.filter((method) => method === 'PUT').length, 1);
  assert(requests.includes('HEAD') && requests.includes('GET'));
  const ref = f.records.get('111').archiveObject;
  assert.equal(sha256([...stored.values()][0]), ref.sha256);
  assert.equal(JSON.parse(readFileSync(f.file)).status, 'complete');
});

test('a retained registration still requires a complete archive read, with no second upload', async (t) => {
  const f = await fixture(t);
  await archiveAcceptedSite(f.options);
  const second = { ...f.options, directory: join(f.root, 'second') };
  f.calls.length = 0;
  await archiveAcceptedSite(second);
  assert.deepEqual(f.calls, ['download', 'get']);
});

test('a failed upload leaves diagnostics from the beginning, releases the lease and hides raw errors', async (t) => {
  const f = await fixture(t);
  const secret = 'https://private.example/?signature=never-print-token';
  f.objects.put = async () => {
    throw Object.assign(Error(secret), { code: 'ETIMEDOUT' });
  };
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  const text = readFileSync(f.file, 'utf8');
  const report = JSON.parse(text);
  assert.equal(report.status, 'failed');
  assert.equal(report.failureCode, 'ETIMEDOUT');
  assert.equal(report.events[0].stage, 'starting');
  assert.equal(report.events.at(-2).stage, 'lease-released');
  assert.equal(text.includes(secret), false);
  assert.equal((await f.coordinator.status()).state, 'idle');
  assert.equal(f.records.size, 0);
});

test('a changed baseline stops before private upload and does not change the accepted website', async (t) => {
  const f = await fixture(t);
  const download = f.source.download;
  f.source.download = async (...args) => {
    const answer = await download(...args);
    const status = await f.coordinator.status();
    const key = `${status.targetId}-site`;
    const scope = f.ledger.inspect().find(([id]) => id === `scopes/${key}`)[1];
    const pointer = { ...scope.baseline, activationId: 'different-accepted-version' };
    f.ledger.replace('scopes', key, { ...scope, active: pointer, baseline: pointer });
    return answer;
  };
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.equal(f.calls.includes('put'), false);
  assert.equal(f.records.size, 0);
  assert.equal(JSON.parse(readFileSync(f.file)).failureCode, 'SITE_ARCHIVE_BASELINE_CHANGED');
  assert.equal((await f.coordinator.status()).state, 'idle');
});

test('a sealed source mismatch is refused before upload', async (t) => {
  const f = await fixture(t);
  const download = f.source.download;
  f.source.download = async (...args) => ({
    ...(await download(...args)),
    headSha: 'f'.repeat(40),
  });
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.equal(f.calls.includes('put'), false);
  assert.equal((await f.coordinator.status()).state, 'idle');
});

test('a baseline change during private upload rejects success and retains the new baseline', async (t) => {
  const f = await fixture(t);
  const put = f.objects.put;
  f.objects.put = async (...args) => {
    const answer = await put(...args);
    const status = await f.coordinator.status();
    const key = `${status.targetId}-site`;
    const scope = f.ledger.inspect().find(([id]) => id === `scopes/${key}`)[1];
    const pointer = { ...scope.baseline, activationId: 'new-baseline-during-upload' };
    f.ledger.replace('scopes', key, { ...scope, active: pointer, baseline: pointer });
    return answer;
  };
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.equal(JSON.parse(readFileSync(f.file)).status, 'failed');
  assert.equal(
    (await f.coordinator.status()).scope.baseline.activationId,
    'new-baseline-during-upload',
  );
  assert.equal((await f.coordinator.status()).state, 'idle');
});

test('a corrupt retained object cannot pass even when its registry already exists', async (t) => {
  const f = await fixture(t);
  await archiveAcceptedSite(f.options);
  const ref = f.records.get('111').archiveObject;
  const bytes = Buffer.from(f.blobs.get(ref.fileID));
  bytes[0] ^= 1;
  f.blobs.set(ref.fileID, bytes);
  f.calls.length = 0;
  await assert.rejects(
    archiveAcceptedSite({ ...f.options, directory: join(f.root, 'retry') }),
    /SITE_ARCHIVE_FAILED/,
  );
  assert.equal(f.calls.includes('put'), false);
  assert.equal((await f.coordinator.status()).state, 'idle');
  assert.equal(JSON.parse(readFileSync(f.file)).status, 'failed');
});

test('long private work renews the shared release lease and stops its timer before release', async (t) => {
  const f = await fixture(t);
  const put = f.objects.put;
  let renews = 0;
  const renew = f.coordinator.renew;
  const coordinator = {
    ...f.coordinator,
    renew(...args) {
      renews++;
      return renew(...args);
    },
  };
  f.objects.put = async (...args) => {
    await new Promise((done) => setTimeout(done, 50));
    return put(...args);
  };
  await archiveAcceptedSite({ ...f.options, coordinator, heartbeatMs: 5 });
  assert(renews > 6);
  const after = renews;
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(renews, after);
  assert.equal((await f.coordinator.status()).state, 'idle');
});

test('an empty rejection cannot become a completed archive', async (t) => {
  const f = await fixture(t);
  f.objects.put = async () => Promise.reject();
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.equal(JSON.parse(readFileSync(f.file)).status, 'failed');
  assert.equal((await f.coordinator.status()).state, 'idle');
});

test('a foreign coordinator target or an unresolved delivery cannot start archiving', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    archiveAcceptedSite({ ...f.options, policy: { ...policy, envId: 'foreign-env' } }),
    /SITE_ARCHIVE_FAILED/,
  );
  assert.deepEqual(f.calls, []);
  await f.coordinator.acquire({ ownerRunId: 'other-run', runnerRef: 'other-runner' });
  await assert.rejects(archiveAcceptedSite(f.options), /SITE_ARCHIVE_FAILED/);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.coordinator.status()).target.lease.ownerRunId, 'other-run');
});

test('diagnostics only retain fixed stages, byte counts, hashes and fixed error categories', async (t) => {
  const f = await fixture(t);
  f.diagnostic.observe({
    kind: 'sdk',
    stage: 'multipart-part',
    totalBytes: 100,
    loadedBytes: 10,
    url: 'never-log',
    headers: { authorization: 'never-log' },
  });
  f.diagnostic.observe({
    kind: 'transfer',
    action: 'put',
    bytes: 100,
    sha256: 'a'.repeat(64),
    elapsedMs: 5,
    outcome: 'unconfirmed',
    cause: 'SECRET',
  });
  f.diagnostic.observe({
    kind: 'sdk',
    stage: 'https://never-log',
    totalBytes: -1,
    loadedBytes: 'never-log',
  });
  const opaque = (text) => ({ secret: 'never-log', toString: () => text });
  f.diagnostic.observe({
    kind: 'transfer',
    action: 'put',
    outcome: 'unconfirmed',
    cause: opaque('http-503'),
    sha256: opaque('a'.repeat(64)),
    artifactId: opaque('111'),
  });
  const text = readFileSync(f.file, 'utf8');
  assert.equal(text.includes('never-log'), false);
  assert.equal(text.includes('SECRET'), false);
  assert(text.includes('multipart-part'));
  assert(text.includes('unconfirmed'));
});

test('archive diagnostics distinguish part listing from completion and retain chronological operation timings', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'site-archive-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 100;
  const diagnostic = createSiteArchiveDiagnostic({
    file: join(root, 'receipt.json'),
    now: () => now,
  });
  now = 300;
  diagnostic.observe({ kind: 'sdk', stage: 'multipart-parts-list', totalBytes: 100 });
  now = 310;
  diagnostic.observe({ kind: 'transfer', action: 'put', outcome: 'complete', elapsedMs: 5 });
  assert.deepEqual(diagnostic.record.events.slice(1), [
    { elapsedMs: 200, kind: 'sdk', stage: 'multipart-parts-list', totalBytes: 100 },
    { elapsedMs: 210, kind: 'transfer', action: 'put', outcome: 'complete', transferElapsedMs: 5 },
  ]);
});

test('manual archive invocation is pinned to exact GitHub source, branch, workflow, environment and region', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: livePolicy.repository,
    GITHUB_REF: livePolicy.trustedRef,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: `${livePolicy.repository}/${livePolicy.workflowPath}@${livePolicy.trustedRef}`,
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '999',
    GITHUB_RUN_ATTEMPT: '1',
    TCB_ENV_ID: livePolicy.envId,
    SITE_URL: livePolicy.siteOrigin,
    CLOUDBASE_REGION: livePolicy.region,
    SITE_ARCHIVE_CONFIRM: 'CURRENT_ACCEPTED_SITE_ONLY',
    TENCENTCLOUD_SECRETID: 'fixture',
    TENCENTCLOUD_SECRETKEY: 'fixture',
    GITHUB_TOKEN: 'fixture',
  };
  assert.doesNotThrow(() => assertSiteArchiveInvocation(env));
  for (const patch of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: 'foreign' },
    { GITHUB_SHA: 'main' },
    { TCB_ENV_ID: 'foreign' },
    { SITE_URL: 'https://foreign.example' },
    { CLOUDBASE_REGION: 'ap-guangzhou' },
    { SITE_ARCHIVE_CONFIRM: '' },
    { TENCENTCLOUD_SECRETID: '' },
  ])
    assert.throws(() => assertSiteArchiveInvocation({ ...env, ...patch }));
});

test('manual workflow queues archive-only work on the existing target and retains failure evidence', () => {
  const workflow = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  assert(workflow.on.workflow_dispatch.inputs.mode.options.includes('site-archive'));
  assert.equal(workflow.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.site_archive;
  assert.equal(job.environment, 'test');
  assert.equal(job.env.SITE_ARCHIVE_CONFIRM, 'CURRENT_ACCEPTED_SITE_ONLY');
  const commands = job.steps.filter((step) => step.env?.TENCENTCLOUD_SECRETKEY);
  assert.equal(commands.length, 1);
  assert.equal(
    commands[0].run,
    './apps/site/node_modules/.bin/tsx scripts/archive-accepted-site.ts',
  );
  assert.equal(job.env.TENCENTCLOUD_SECRETKEY, undefined);
  const evidence = job.steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  assert.equal(evidence.if, 'always()');
  assert.equal(evidence.with.path, 'output/site-archive/receipt.json');
  assert.equal(evidence.with['if-no-files-found'], 'error');
  const source = readFileSync('scripts/archive-accepted-site.ts', 'utf8');
  assert(source.indexOf('await source.requireCI(') < source.indexOf('blogWorkerSdk(config)'));
  assert.equal(
    /createCanaryProvider|deliverStaticContent|seedCatalog|uploadFiles|updateWebsiteConfig/.test(
      source,
    ),
    false,
  );
});
