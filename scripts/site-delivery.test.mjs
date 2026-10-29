import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publicFiles } from './release-fixtures.mjs';
import {
  configuration,
  errorHtml,
  httpFixture,
  objectResponse,
} from './release-hosting-fixtures.mjs';
import { memoryStore } from './release-state-fixtures.mjs';
import { hostingBatchBeforeHash, hostingRemovalHash } from './release/hosting-batches.mjs';
import { identity } from './release/input.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { deliverStaticContent } from './release/static-delivery.mjs';
const policy = {
  repository: 'fixture/channel',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
  workflowPath: '.github/workflows/deploy-test.yml',
  trustedRef: 'refs/heads/test',
};
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'site-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configuration();
  const files = new Map();
  const times = new Map();
  const writes = [];
  let clock = 0;
  let unknown = false;
  let unknownRemove = false;
  let writeHook = async (_path) => {};
  let seq = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 24, 0, 0, ++clock)).toISOString();
  const http = await httpFixture(t, (req, res) => {
    let p = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!p || p.endsWith('/')) p += 'index.html';
    const body = files.get(p) ?? Buffer.from(errorHtml);
    objectResponse(req, res, {
      body,
      status: files.has(p) ? 200 : 404,
      etag: `"${createHash('md5').update(body).digest('hex')}"`,
      cache: 'no-store',
      mime: p.endsWith('.xml')
        ? 'application/xml'
        : p.endsWith('.json')
          ? 'application/json'
          : p.endsWith('.js')
            ? 'application/javascript'
            : 'text/html',
    });
  });
  const provider = {
    target: { envId: policy.envId, site: policy.siteOrigin },
    readConfiguration: async () => structuredClone(config),
    readInventory: async () =>
      [...files].map(([path, b]) => ({
        path,
        bytes: b.length,
        etag: `"${createHash('md5').update(b).digest('hex')}"`,
        lastModified: times.get(path),
      })),
    upload: async (path, bytes) => {
      await writeHook(path);
      writes.push(['put', path]);
      files.set(path, Buffer.from(bytes));
      times.set(path, stamp());
      if (unknown === true || unknown === path) throw Error('lost upload acknowledgement');
      return { terminal: true };
    },
    remove: async (path) => {
      writes.push(['remove', path]);
      files.delete(path);
      times.delete(path);
      if (unknownRemove) throw Error('lost delete acknowledgement');
      return { terminal: true };
    },
    configure: async () => {
      throw Error('Global configuration forbidden');
    },
  };
  let now = Date.now();
  const coordinator = createReleaseCoordinator({ store: memoryStore(), policy, clock: () => now });
  const sources = new Map();
  function source(label, { article = false, products = [], image = false } = {}) {
    const id = String(++seq);
    const data = new Map(
      Object.entries({
        ...publicFiles(products),
        'errors/not-found.html': errorHtml,
        'index.html': `<main>${label}</main>`,
      }).map(([p, b]) => [p, Buffer.from(b)]),
    );
    if (article) data.set('blog/one/index.html', Buffer.from(`<main>${label} article</main>`));
    if (image)
      data.set(
        `media/articles/owned-image/${'c'.repeat(64)}.png`,
        Buffer.from('published image bytes'),
      );
    const directory = join(root, `payload-${id}`);
    createSitePayload({
      directory,
      policy,
      configuration: config,
      codeSha: 'a'.repeat(40),
      releaseId: `site-${id}`,
      snapshot: { siteOrigin: policy.siteOrigin, purpose: 'legacy-public-inventory' },
      files: data,
    });
    const run = {
      repository: policy.repository,
      workflowPath: policy.workflowPath,
      event: 'workflow_dispatch',
      ref: policy.trustedRef,
      headSha: 'a'.repeat(40),
      runId: id,
      artifact: { id, runId: id, expired: false, expiresAt: '2026-12-31T00:00:00Z' },
    };
    const input = siteArtifact({ directory, policy, run });
    input.ownedPaths = [
      ...new Set([...files.keys()].filter((p) => p !== 'foreign.html').concat([...data.keys()])),
    ];
    sources.set(id, { directory, run });
    return { input, data };
  }
  const accepted = async (run) => {
    const s = sources.get(run.composition.static.artifact.artifactId);
    return siteArtifact({ ...s, policy, acceptedSeal: run.accepted.seals.static });
  };
  async function deliver(input, mode = 'publish', extra = {}) {
    const runId = `run-${++seq}`;
    const guard = await coordinator.acquire({
      ownerRunId: runId,
      runnerRef: `github:fixture/channel:${seq}:site`,
    });
    const result = await deliverStaticContent(
      {
        coordinator,
        provider,
        guard,
        runId,
        input,
        mode,
        publicProductPaths: [],
        loadAccepted: accepted,
        request: http.request,
        adapterOptions: { heartbeatMs: 10, pollIntervalMs: 1 },
        ...extra,
      },
      { policy, scopeKey: 'site' },
    );
    const status = await coordinator.status();
    if (
      status.state === 'leased' &&
      !status.pendingStep &&
      !status.target.currentRunId &&
      !status.target.dirtyRunId
    )
      await coordinator.release(guard);
    return result;
  }
  const a = source('A');
  for (const [p, b] of a.data) {
    files.set(p, b);
    times.set(p, stamp());
  }
  files.set('foreign.html', Buffer.from('another operator'));
  times.set('foreign.html', stamp());
  a.input.ownedPaths = [];
  const adopted = await deliver(a.input, 'adopt');
  assert.equal(adopted.status, 'accepted', JSON.stringify(adopted));
  assert.equal(writes.length, 0);
  return {
    source,
    a,
    now: () => now,
    expireLease: () => {
      now += 200000;
    },
    deliver,
    writes,
    files,
    request: http.request,
    coordinator,
    onWrite: (hook) => {
      writeHook = hook;
    },
    setUnknownRemove: (value) => {
      unknownRemove = value;
    },
    setUnknown: (value = true) => {
      unknown = value;
    },
  };
}
test('formal site adopts actual A without writes, publishes B incrementally and withdraws its exact article', async (t) => {
  const f = await setup(t);
  const b = f.source('B', { article: true });
  const result = await f.deliver(b.input);
  assert.equal(result.status, 'accepted');
  assert.equal(f.files.get('blog/one/index.html').toString(), '<main>B article</main>');
  assert(!f.writes.some(([, path]) => path === '_astro/a.hash.js'));
  assert(f.files.has('foreign.html'));
  const c = f.source('C');
  assert.equal((await f.deliver(c.input)).status, 'accepted');
  assert(!f.files.has('blog/one/index.html'));
  assert(f.files.has('foreign.html'));
});
test('verified write failure restores exactly accepted A once while preserving foreign files', async (t) => {
  const f = await setup(t);
  const b = f.source('B', { article: true });
  const result = await f.deliver(b.input, 'publish', {
    postCheck: async ({ action }) => {
      if (action === 'publish') throw Error('confirmed post-check failure');
    },
  });
  assert.equal(result.status, 'restored');
  assert.equal(f.files.get('index.html').toString(), '<main>A</main>');
  assert(!f.files.has('blog/one/index.html'));
  assert(f.files.has('foreign.html'));
});
test('unknown upload outcome stops and never starts speculative recovery', async (t) => {
  const f = await setup(t);
  f.setUnknown();
  const b = f.source('B', { article: true });
  const result = await f.deliver(b.input);
  assert.equal(result.status, 'unknown');
  assert.equal(f.writes.length, 1);
  assert((await f.coordinator.status()).pendingStep);
});

test('a newly withdrawn product can be removed from accepted A; stale recovery cannot revive it', async (t) => {
  const f = await setup(t);
  const path = '/products/p-withdrawn/';
  const a = f.source('Product A', { products: [path] });
  const stops = [];
  const first = await f.deliver(a.input, 'publish', {
    publicProductPaths: [path],
    onStop: (phase, error) => stops.push({ phase, message: error.message, code: error.code }),
  });
  assert.equal(first.status, 'accepted', JSON.stringify({ first, stops }));
  const b = f.source('Withdrawn B');
  assert.equal(
    (await f.deliver(b.input, 'publish', { publicProductPaths: [] })).status,
    'accepted',
  );
  assert(!f.files.has('products/p-withdrawn/index.html'));
});

test('failed or withdrawn publication removes only unreferenced public article image copies', async (t) => {
  const f = await setup(t);
  const path = `media/articles/owned-image/${'c'.repeat(64)}.png`;
  const b = f.source('Article B', { article: true, image: true });
  const failed = await f.deliver(b.input, 'publish', {
    postCheck: async ({ action }) => {
      if (action === 'publish') throw Error('controlled verification failure');
    },
  });
  assert.equal(failed.status, 'restored');
  assert(!f.files.has(path));
  const c = f.source('Article C', { article: true, image: true });
  assert.equal((await f.deliver(c.input)).status, 'accepted');
  assert(f.files.has(path));
  const d = f.source('Withdraw D');
  assert.equal((await f.deliver(d.input)).status, 'accepted');
  assert(!f.files.has(path));
  assert(f.files.has('foreign.html'));
});

test('a stopped runner is reconciled by actual readback, then manual restoration removes partial B and restores accepted A', async (t) => {
  const f = await setup(t);
  const a = await f.coordinator.status({ scopeKey: 'site' });
  const b = f.source('B', { article: true });
  f.setUnknown();
  assert.equal((await f.deliver(b.input)).status, 'unknown');
  const stuck = await f.coordinator.status({ scopeKey: 'site' });
  assert(stuck.pendingStep);
  f.expireLease();
  const path =
    stuck.pendingStep.members?.[0]?.path ?? stuck.pendingStep.subject.replace(/^upload:/, '');
  await f.coordinator.reconcile({
    expectedVersion: stuck.target.version,
    expectedFence: stuck.target.lease.fence,
    proof: {
      runnerRef: stuck.target.lease.runnerRef,
      job: { status: 'completed', evidenceRef: 'github:completed' },
      cloud: {
        status: 'quiescent',
        operationId: stuck.pendingStep.operationId,
        observedHash: stuck.pendingStep.members
          ? identity(
              stuck.pendingStep.members.map((e) => ({
                path: e.path,
                sha256: f.files.has(e.path)
                  ? createHash('sha256').update(f.files.get(e.path)).digest('hex')
                  : 'absent',
              })),
            )
          : createHash('sha256').update(f.files.get(path)).digest('hex'),
        evidenceRef: 'actual-object-readback',
      },
      checkedAt: f.now(),
    },
  });
  f.setUnknown(false);
  const result = await f.deliver(f.a.input, 'restore', {
    restoreRunId: a.scope.baseline.sourceRunId,
    failedCandidates: [
      { run: await f.coordinator.runStatus(stuck.target.dirtyRunId), input: b.input },
    ],
  });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(f.files.get('index.html').toString(), '<main>A</main>');
  assert(!f.files.has('blog/one/index.html'));
  assert(f.files.has('foreign.html'));
  assert.equal((await f.coordinator.status()).target.dirtyRunId, null);
});

async function reconcileFixture(f) {
  const state = await f.coordinator.status({ scopeKey: 'site' });
  const step = state.pendingStep;
  f.expireLease();
  const digest = (path) =>
    f.files.has(path) ? createHash('sha256').update(f.files.get(path)).digest('hex') : 'absent';
  const removed = step.removals?.map((row) => ({ path: row.path, beforeHash: digest(row.path) }));
  const observedHash = step.members
    ? identity(step.members.map((e) => ({ path: e.path, sha256: digest(e.path) })))
    : removed
      ? removed.every((row) => row.beforeHash === 'absent')
        ? hostingRemovalHash(removed.map((row) => row.path))
        : hostingBatchBeforeHash(removed)
      : digest(step.subject.replace(/^(?:upload|remove):/, ''));
  await f.coordinator.reconcile({
    expectedVersion: state.target.version,
    expectedFence: state.target.lease.fence,
    proof: {
      runnerRef: state.target.lease.runnerRef,
      job: { status: 'completed', evidenceRef: 'finished-fixture-runner' },
      cloud: {
        status: 'quiescent',
        operationId: step.operationId,
        observedHash,
        evidenceRef: 'fixture-http-and-inventory',
      },
      checkedAt: f.now(),
    },
  });
  return f.coordinator.runStatus(state.target.dirtyRunId);
}

test('recovery interrupted during deletion can be resumed using the complete A/B history', async (t) => {
  const f = await setup(t);
  const initial = await f.coordinator.status({ scopeKey: 'site' });
  const b = f.source('B', { article: true, image: true });
  f.setUnknown('index.html');
  assert.equal((await f.deliver(b.input)).status, 'unknown');
  const failedB = await reconcileFixture(f);
  f.setUnknown(false);
  f.setUnknownRemove(true);
  const firstRestore = await f.deliver(f.a.input, 'restore', {
    restoreRunId: initial.scope.baseline.sourceRunId,
    failedCandidates: [{ run: failedB, input: b.input }],
  });
  assert.equal(firstRestore.status, 'unknown');
  assert.equal((await f.coordinator.status()).pendingStep.removals.length, 2);
  const failedRestore = await reconcileFixture(f);
  f.setUnknownRemove(false);
  const chain = [
    { run: failedRestore, input: f.a.input },
    { run: failedB, input: b.input },
  ];
  const secondRestore = await f.deliver(f.a.input, 'restore', {
    restoreRunId: initial.scope.baseline.sourceRunId,
    failedCandidates: chain,
  });
  assert.equal(secondRestore.status, 'accepted', JSON.stringify(secondRestore));
  assert.equal(f.files.get('index.html').toString(), '<main>A</main>');
  assert(!f.files.has('blog/one/index.html'));
  assert(!f.files.has(`media/articles/owned-image/${'c'.repeat(64)}.png`));
  assert(f.files.has('foreign.html'));
});

test('every batched upload has its exact path and hash in the persisted intent before the SDK writes', async (t) => {
  const f = await setup(t);
  const b = f.source('B', { article: true, image: true });
  let checked = 0;
  f.onWrite(async (path) => {
    const state = await f.coordinator.status({ scopeKey: 'site' });
    assert.equal(state.pendingStep.state, 'intent');
    const member = state.pendingStep.members.find((e) => e.path === path);
    assert(member);
    assert(member.beforeHash);
    assert(member.sha256);
    checked++;
  });
  assert.equal((await f.deliver(b.input)).status, 'accepted');
  assert(checked >= 3);
});

test('final full-site acceptance has a bounded whole-site budget and still reads every ordinary URL', async (t) => {
  const f = await setup(t);
  const b = f.source('B', { article: true });
  const reads = [];
  const request = async (method, url, options) => {
    const state = await f.coordinator.status({ scopeKey: 'site' });
    if (state.pendingStep?.kind === 'accept') {
      await new Promise((resolve) => setTimeout(resolve, 40));
      reads.push(new URL(url).pathname);
    }
    return f.request(method, url, options);
  };
  const result = await f.deliver(b.input, 'publish', {
    request,
    adapterOptions: {
      heartbeatMs: 10,
      pollIntervalMs: 1,
      operationTimeoutMs: 100,
      requestTimeoutMs: 2000,
    },
  });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert(reads.filter((path) => path === '/').length >= 3);
  assert(reads.filter((path) => path === '/blog/one/').length >= 3);
});

test('a recovery checkpoint accepts unchanged files but refuses any upload or removal before cloud writes', async (t) => {
  const f = await setup(t);
  const b = f.source('a changed website');
  const refused = await f.deliver(b.input, 'publish', { requireUnchangedFiles: true });
  assert.equal(refused.status, 'not-written');
  assert.equal(f.writes.length, 0);
  const same = f.source('A');
  const accepted = await f.deliver(same.input, 'publish', { requireUnchangedFiles: true });
  assert.equal(accepted.status, 'accepted');
  assert.equal(f.writes.length, 0);
});

test('current-data recovery replaces a failed candidate without resurrecting the accepted historical content', async (t) => {
  const f = await setup(t);
  const b = f.source('B');
  const failed = await f.deliver(b.input, 'publish', {
    allowRecovery: async () => false,
    postCheck: async () => {
      throw Error('confirmed failure');
    },
  });
  assert.equal(failed.status, 'unknown');
  const status = await f.coordinator.status({ scopeKey: 'site' });
  const dirty = await f.coordinator.runStatus(status.target.dirtyRunId);
  f.expireLease();
  await f.coordinator.reconcile({
    expectedVersion: status.target.version,
    expectedFence: status.target.lease.fence,
    proof: {
      runnerRef: status.target.lease.runnerRef,
      job: { status: 'completed', evidenceRef: 'finished-owner' },
      cloud: {
        status: 'quiescent',
        operationId: null,
        observedHash: null,
        evidenceRef: 'all-storage-requests-terminal',
      },
      checkedAt: f.now(),
    },
  });
  const c = f.source('C');
  const result = await f.deliver(c.input, 'reconcile', {
    failedCandidates: [{ run: dirty, input: b.input }],
  });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  for (const [path, bytes] of c.data) assert.deepEqual(f.files.get(path), bytes);
  assert.equal((await f.coordinator.status({ scopeKey: 'site' })).target.dirtyRunId, null);
});
