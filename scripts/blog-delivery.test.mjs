import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deliverBlogDummy } from './blog/delivery.mjs';
import { validateBlogArtifactSource } from './blog/github-source.mjs';
import { blogDummyArtifact, createBlogDummyPayload } from './blog/payload.mjs';
import { assertBlogDummyInvocation, BLOG_DUMMY_POLICY as policy } from './blog/policy.mjs';
import {
  configuration,
  errorHtml,
  httpFixture,
  objectResponse,
} from './release-hosting-fixtures.mjs';
import { memoryStore } from './release-state-fixtures.mjs';
import { sha256 } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'blog-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const objects = new Map([
    ['index.html', Buffer.from('Existing homepage')],
    ['errors/not-found.html', Buffer.from(errorHtml)],
  ]);
  const writes = [];
  let unknownUpload = false;
  const config = configuration();
  config.gateway.Domains[0].Domain = 'supplychainsai.com';
  const http = await httpFixture(t, (req, res) => {
    let path = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!path || path.endsWith('/')) path += 'index.html';
    const body = objects.get(path);
    objectResponse(req, res, {
      body: body ?? Buffer.from(errorHtml),
      status: body ? 200 : 404,
      etag: `"${sha256(body ?? Buffer.from(errorHtml))}"`,
      cacheControl: 'no-store',
      type: path.endsWith('.js') ? 'application/javascript' : 'text/html',
    });
  });
  const provider = {
    target: { envId: policy.envId, site: policy.siteOrigin },
    readConfiguration: async () => structuredClone(config),
    inventory: async (prefix) => [...objects.keys()].filter((path) => path.startsWith(prefix)),
    upload: async (path, bytes) => {
      writes.push(['put', path]);
      objects.set(path, Buffer.from(bytes));
      if (unknownUpload) throw new Error('Upload reply lost');
      return { terminal: true };
    },
    remove: async (path) => {
      writes.push(['remove', path]);
      objects.delete(path);
      return { terminal: true };
    },
    configure: async () => {
      throw new Error('Global writes forbidden');
    },
  };
  const coordinator = createReleaseCoordinator({
    store: { ...memoryStore(), envId: policy.envId },
    policy,
  });
  const sources = new Map();
  let n = 0;
  function source(label, { withdraw = false, baseline } = {}) {
    const id = String(++n);
    const build = join(root, `build-${id}`);
    const payload = join(root, `payload-${id}`);
    mkdirSync(build);
    const html = `<meta name="robots" content="noindex,nofollow"><main>${label}</main>`;
    writeFileSync(join(build, 'index.html'), html);
    if (!withdraw) {
      mkdirSync(join(build, 'article'));
      writeFileSync(join(build, 'article/index.html'), html);
    }
    createBlogDummyPayload({
      buildDirectory: build,
      directory: payload,
      configuration: config,
      codeSha: 'a'.repeat(40),
      taskId: `task-${id}`,
      baseline,
    });
    const run = {
      repository: policy.repository,
      workflowPath: policy.workflowPath,
      event: 'workflow_dispatch',
      ref: policy.trustedRef,
      headSha: 'a'.repeat(40),
      runId: id,
      artifact: {
        id: String(100 + Number(id)),
        runId: id,
        expired: false,
        expiresAt: '2027-10-23T00:00:00.000Z',
      },
    };
    const result = blogDummyArtifact({ directory: payload, run });
    sources.set(run.artifact.id, { directory: payload, run });
    return result;
  }
  const loadAccepted = async (run) =>
    blogDummyArtifact({
      ...sources.get(run.composition.static.artifact.artifactId),
      acceptedSeal: run.accepted.seals.static,
    });
  async function deliver(input, key, options = {}) {
    const guard = await coordinator.acquire({ ownerRunId: key, runnerRef: `fixture:${key}` });
    return deliverBlogDummy({
      coordinator,
      provider,
      guard,
      runId: key,
      input,
      loadAccepted,
      request: http.request,
      adapterOptions: { heartbeatMs: 20, operationTimeoutMs: 3000, pollIntervalMs: 1 },
      ...options,
    });
  }
  return {
    source,
    deliver,
    objects,
    writes,
    coordinator,
    loadAccepted,
    unknown: () => {
      unknownUpload = true;
    },
  };
}

test('Blog uses actual HTTP GET/ETag checks through A, B and exact accepted A recovery', async (t) => {
  const f = await fixture(t);
  const a = f.source('A');
  assert.equal((await f.deliver(a, 'A')).status, 'accepted');
  const before = f.objects.get('index.html');
  const b = f.source('B');
  const result = await f.deliver(b, 'B', {
    postCheck: async ({ action }) => {
      if (action === 'publish') throw new Error('Controlled post-upload failure');
    },
  });
  assert.equal(result.status, 'restored');
  assert.equal(f.objects.get('__blog-dummy/article/index.html').toString().includes('A'), true);
  assert.deepEqual(f.objects.get('index.html'), before);
  assert.ok(f.writes.every(([, path]) => path.startsWith('__blog-dummy/')));
  assert.equal((await f.coordinator.status({ scopeKey: 'canary' })).state, 'idle');
});
test('withdraw removes only the owned article HTML and verifies its real HTTP 404', async (t) => {
  const f = await fixture(t);
  await f.deliver(f.source('A'), 'A');
  assert.equal(
    (await f.deliver(f.source('Withdraw', { withdraw: true }), 'withdraw')).status,
    'accepted',
  );
  assert.equal(f.objects.has('__blog-dummy/article/index.html'), false);
  assert.ok(f.objects.has('__blog-dummy/index.html'));
  assert.deepEqual(
    f.writes.filter(([action]) => action === 'remove'),
    [['remove', '__blog-dummy/article/index.html']],
  );
});
test('lost cloud upload response remains unknown and does not launch recovery or another upload', async (t) => {
  const f = await fixture(t);
  await f.deliver(f.source('A'), 'A');
  const count = f.writes.length;
  f.unknown();
  assert.equal((await f.deliver(f.source('B'), 'B')).status, 'unknown');
  assert.equal(f.writes.length, count + 1);
  assert.ok((await f.coordinator.status({ scopeKey: 'canary' })).pendingStep);
});
test('occupied prefix or an unexpected file prevents writes before delivery', async (t) => {
  const f = await fixture(t);
  f.objects.set('__blog-dummy/foreign.html', Buffer.from('Other owner'));
  assert.equal((await f.deliver(f.source('A'), 'A')).status, 'not-written');
  assert.equal(f.writes.length, 0);
});
test('a failed recovery does not recursively choose another version', async (t) => {
  const f = await fixture(t);
  await f.deliver(f.source('A'), 'A');
  const result = await f.deliver(f.source('B'), 'B', {
    postCheck: async () => {
      throw new Error('Both checks fail');
    },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(f.writes.length, 6, 'A, B and one A recovery only');
});
test('archived payload rejects bytes modified after its manifest was saved', async (t) => {
  const f = await fixture(t);
  const source = f.source('A');
  writeFileSync(join(source.directory, '__blog-dummy/index.html'), 'changed');
  assert.throws(() => blogDummyArtifact({ directory: source.directory, run: source.run }));
});
test('live worker requires exact repository, branch, target and explicit isolated confirmation', () => {
  assert.throws(() => assertBlogDummyInvocation({}));
  const valid = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: policy.repository,
    GITHUB_REF: policy.trustedRef,
    GITHUB_JOB: 'dummy',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    TCB_ENV_ID: policy.envId,
    SITE_URL: policy.siteOrigin,
    CLOUDBASE_REGION: policy.region,
    BLOG_DUMMY_CONFIRM: 'ISOLATED_BLOG_ONLY',
  };
  assert.deepEqual(assertBlogDummyInvocation(valid), policy);
  for (const change of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/main' },
    { TCB_ENV_ID: 'other' },
    { SITE_URL: 'https://other.example' },
    { BLOG_DUMMY_CONFIRM: 'yes' },
  ])
    assert.throws(() => assertBlogDummyInvocation({ ...valid, ...change }));
});
test('artifact metadata refuses another repository, workflow, branch, expiry or unaccepted failed run', () => {
  const run = {
    id: 1,
    run_attempt: 1,
    path: policy.workflowPath,
    event: 'workflow_dispatch',
    head_branch: policy.trustedRef.slice(11),
    head_sha: 'a'.repeat(40),
    repository: { id: 5, full_name: policy.repository },
    head_repository: { id: 5, full_name: policy.repository },
    status: 'completed',
    conclusion: 'success',
  };
  const artifact = {
    id: 10,
    expired: false,
    expires_at: '2027-10-23T00:00:00.000Z',
    size_in_bytes: 100,
    digest: `sha256:${'b'.repeat(64)}`,
    name: 'blog-dummy-payload-1-1',
    workflow_run: {
      repository_id: 5,
      head_repository_id: 5,
      id: 1,
      head_sha: run.head_sha,
      head_branch: run.head_branch,
    },
  };
  assert.equal(validateBlogArtifactSource(artifact, run).artifact.id, '10');
  for (const change of [
    { expired: true },
    { expires_at: '2000-01-01' },
    { name: 'unrelated' },
    { workflow_run: { ...artifact.workflow_run, repository_id: 6 } },
  ])
    assert.throws(() => validateBlogArtifactSource({ ...artifact, ...change }, run));
  assert.throws(() => validateBlogArtifactSource(artifact, { ...run, conclusion: 'failure' }));
});

test('an external website change stops recovery writes even after a verified dummy upload', async (t) => {
  const f = await fixture(t);
  await f.deliver(f.source('A'), 'A');
  const count = f.writes.length;
  const result = await f.deliver(f.source('B'), 'B', {
    postCheck: async () => {
      throw Object.assign(new Error('Unrelated deployment changed the homepage'), {
        code: 'STOP_EXTERNAL_CHANGE',
      });
    },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(f.writes.length, count + 2, 'No extra A recovery writes after external drift');
});

test('payload actively rejects indexable/private HTML and links before archiving', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'blog-payload-denied-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = join(root, 'build');
  mkdirSync(build);
  for (const html of [
    '<main>Indexable</main>',
    '<meta name="robots" content="noindex,nofollow"><main>cloud://private/secret</main>',
  ]) {
    writeFileSync(join(build, 'index.html'), html);
    assert.throws(() =>
      createBlogDummyPayload({
        buildDirectory: build,
        directory: join(root, 'payload'),
        configuration: configuration(),
        codeSha: 'a'.repeat(40),
        taskId: 'task',
      }),
    );
  }
});

test('real HTTP bridge allows only its owned admin origin, handles preflight and rejects business actions', async (t) => {
  const { createBlogBridgeServer } = await import('./blog/bridge-http.mjs');
  let calls = 0;
  const origin = 'http://127.0.0.1:43210';
  const server = createBlogBridgeServer({
    adminOrigin: origin,
    invoke: async () => {
      calls++;
      return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } };
    },
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(
    () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/api/admin`;
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  const wrong = await fetch(url, {
    method: 'POST',
    headers: { origin: 'https://foreign.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'me' }),
  });
  assert.equal(wrong.status, 403);
  assert.equal(calls, 0);
  const business = await fetch(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'update', data: { collection: 'products' } }),
  });
  assert.equal(business.status, 502);
  assert.equal(calls, 0);
  const allowed = await fetch(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'me' }),
  });
  assert.equal(allowed.status, 401);
  assert.equal(calls, 1);
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
});
