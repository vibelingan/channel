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
      cacheControl: 'no-store',
      type: p.endsWith('.xml')
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
      writes.push(['put', path]);
      files.set(path, Buffer.from(bytes));
      times.set(path, stamp());
      if (unknown) throw Error('lost upload acknowledgement');
      return { terminal: true };
    },
    remove: async (path) => {
      writes.push(['remove', path]);
      files.delete(path);
      times.delete(path);
      return { terminal: true };
    },
    configure: async () => {
      throw Error('Global configuration forbidden');
    },
  };
  const coordinator = createReleaseCoordinator({ store: memoryStore(), policy });
  const sources = new Map();
  function source(label, { article = false } = {}) {
    const id = String(++seq);
    const data = new Map(
      Object.entries({
        ...publicFiles([]),
        'errors/not-found.html': errorHtml,
        'index.html': `<main>${label}</main>`,
      }).map(([p, b]) => [p, Buffer.from(b)]),
    );
    if (article) data.set('blog/one/index.html', Buffer.from(`<main>${label} article</main>`));
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
    deliver,
    writes,
    files,
    coordinator,
    setUnknown: () => {
      unknown = true;
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
