import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoveryStateIdentity } from './hosting-recovery.mjs';
import {
  configuration,
  entry,
  errorHtml,
  httpFixture,
  objectResponse,
} from './release-hosting-fixtures.mjs';
import { hostingBatchHash, hostingRemovalHash } from './release/hosting-batches.mjs';
import { configurationHash } from './release/hosting-configuration.mjs';
import { identity } from './release/input.mjs';
import { normalizePolicy } from './release/ledger.mjs';
import { siteReadbackEvidence, verifySiteReadback } from './release/site-readback.mjs';
async function fixture(t) {
  const policy = {
    repository: 'fixture/channel',
    envId: 'fixture-env',
    siteOrigin: 'https://fixture.example',
  };
  const directory = mkdtempSync(join(tmpdir(), 'read-only-site-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bodies = new Map([
    ['index.html', '<h1>Home</h1>'],
    ['errors/not-found.html', errorHtml],
  ]);
  for (const [path, b] of bodies) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), b);
  }
  const entries = [...bodies].map(([path, b]) => entry(path, b));
  const config = configuration();
  const target = { envId: policy.envId, site: policy.siteOrigin };
  const staticManifest = {
    entries,
    configuration: structuredClone(config),
    configurationSha256: configurationHash(config),
  };
  const artifact = { id: 'exact-original-artifact' };
  const input = {
    directory,
    staticManifest,
    envelope: { artifact, releaseId: 'B', codeSha: 'b'.repeat(40) },
  };
  const hash = recoveryStateIdentity({
    target,
    scope: { kind: 'site' },
    uploads: entries,
    deletes: [],
    configurationSha256: staticManifest.configurationSha256,
  });
  const members = [{ ...entries[0], beforeHash: 'a'.repeat(64) }];
  const afterHash = hostingBatchHash(members);
  const run = {
    runId: 'B',
    state: 'RUNNING',
    accepted: null,
    kind: 'publish',
    scopeKey: 'site',
    targetId: normalizePolicy(policy).targetId,
    deliveredComponents: ['static'],
    verifiedSteps: 1,
    verifiedWrites: 1,
    fence: 2,
    composition: { static: { ...input.envelope, contentSha256: hash } },
    plan: { stepCount: 2, acceptanceHash: hash, planSha256: 'c'.repeat(64) },
  };
  const step = {
    sequence: 0,
    runId: 'B',
    targetId: run.targetId,
    fence: 2,
    kind: 'write',
    component: 'static',
    state: 'verified',
    planSha256: run.plan.planSha256,
    members,
    afterHash,
    subject: `upload-batch:${afterHash}`,
    verifySubject: `read-batch:${afterHash}`,
    executionId: 'execution',
    intentHash: 'intent',
    operationId: 'operation',
  };
  step.receipt = {
    status: 'verified',
    observedHash: afterHash,
    expectedHash: afterHash,
    terminal: true,
    intentHash: step.intentHash,
    operationId: step.operationId,
    executionId: step.executionId,
    planSha256: step.planSha256,
    subject: step.verifySubject,
  };
  let inventory = entries.map((e) => ({
    path: e.path,
    bytes: e.bytes,
    etag: createHash('md5').update(bodies.get(e.path)).digest('hex'),
    lastModified: '2026-10-26T00:00:00Z',
  }));
  const http = await httpFixture(t, (req, res) => {
    const path = req.url === '/' ? 'index.html' : req.url.slice(1);
    objectResponse(req, res, { body: bodies.get(path), etag: '"exact"', cache: 'no-store' });
  });
  return {
    run,
    input,
    steps: [step],
    policy,
    request: http.request,
    provider: {
      readInventory: async () => structuredClone(inventory),
      readConfiguration: async () => structuredClone(config),
    },
    inventory,
    config,
    http,
    setInventory: (x) => {
      inventory = x;
    },
  };
}
test('read-only acceptance verifies the exact existing candidate without exposing write callbacks', async (t) => {
  const f = await fixture(t);
  let browser = 0;
  const result = await verifySiteReadback({
    ...f,
    postCheck: async () => {
      browser++;
    },
  });
  assert.equal(result.websiteWrites, 0);
  assert.equal(result.observedHash, f.run.plan.acceptanceHash);
  assert.equal(browser, 1);
  assert.equal(f.http.requests.length, 3);
});
for (const bad of ['candidate', 'receipt', 'sequence', 'fence', 'write-count'])
  test(`read-only acceptance rejects inconsistent ${bad}`, async (t) => {
    const f = await fixture(t);
    if (bad === 'candidate') f.input.envelope.codeSha = 'e'.repeat(40);
    if (bad === 'receipt') f.steps[0].receipt.terminal = false;
    if (bad === 'sequence') f.steps[0].sequence = 1;
    if (bad === 'fence') f.steps[0].fence++;
    if (bad === 'write-count') f.run.verifiedWrites++;
    assert.throws(() => siteReadbackEvidence(f));
    assert.equal(f.http.requests.length, 0);
  });
for (const bad of ['file-bytes', 'config', 'concurrent-change'])
  test(`read-only acceptance rejects ${bad}`, async (t) => {
    const f = await fixture(t);
    if (bad === 'file-bytes') f.inventory[0].etag = 'unknown';
    if (bad === 'config') f.config.gateway.Domains[0].Enable = false;
    await assert.rejects(
      verifySiteReadback({
        ...f,
        postCheck: async () => {
          if (bad === 'concurrent-change') f.inventory[0].lastModified = 'new';
        },
      }),
    );
  });

test('pre-existing files outside the publisher ownership stay unchanged and are not adopted', async (t) => {
  const f = await fixture(t);
  f.inventory.push({ ...f.inventory[0], path: '_astro/previous.ABCD1234.js' });
  const result = await verifySiteReadback(f);
  assert.deepEqual(result.preservedOutsideCandidate, ['_astro/previous.ABCD1234.js']);
  assert.equal(result.observedHash, f.run.plan.acceptanceHash);
  assert.equal(result.websiteWrites, 0);
  assert.equal(f.http.requests.length, 3);
});

test('a path explicitly removed by this publication cannot reappear', async (t) => {
  const f = await fixture(t);
  const removals = [{ path: 'retired/index.html', beforeHash: 'a'.repeat(64) }];
  const afterHash = hostingRemovalHash(removals.map((x) => x.path));
  const step = {
    ...f.steps[0],
    sequence: 1,
    members: undefined,
    removals,
    afterHash,
    subject: `remove-batch:${afterHash}`,
    verifySubject: `remove-batch:${afterHash}`,
  };
  step.receipt = {
    ...step.receipt,
    observedHash: afterHash,
    expectedHash: afterHash,
    subject: step.verifySubject,
  };
  f.steps.push(step);
  f.run.verifiedWrites = 2;
  f.run.verifiedSteps = 2;
  f.run.plan.stepCount = 3;
  const hash = recoveryStateIdentity({
    target: { envId: f.policy.envId, site: f.policy.siteOrigin },
    scope: { kind: 'site' },
    uploads: f.input.staticManifest.entries,
    deletes: removals.map((x) => x.path),
    configurationSha256: f.input.staticManifest.configurationSha256,
  });
  f.run.plan.acceptanceHash = hash;
  f.run.composition.static.contentSha256 = hash;
  f.inventory.push({ ...f.inventory[0], path: 'retired/index.html' });
  await assert.rejects(verifySiteReadback(f), /removed file reappeared/);
});
