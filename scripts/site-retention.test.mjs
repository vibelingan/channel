import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration } from './release-hosting-fixtures.mjs';
import {
  ARCHIVE_COS_OPTIONS,
  PARALLEL_ARCHIVE_COS_OPTIONS,
} from './release/cos-archive-transfer.mjs';
import { sha256 } from './release/input.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
import {
  UPLOAD_PART_BUDGET,
  createSiteRetention,
  mapByParts,
  retainedSiteProof,
  uploadParts,
} from './release/site-retention.mjs';
const policy = {
  repository: 'vibelingan/channel',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
  workflowPath: '.github/workflows/seo-static-canary.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
};
function payload(root, { runId = '101', artifactId = '111', files } = {}) {
  const directory = join(root, `candidate-${artifactId}`);
  const codeSha = 'a'.repeat(40);
  createSitePayload({
    directory,
    policy,
    configuration: configuration(),
    codeSha,
    releaseId: `site-${runId}-1`,
    files:
      files ??
      new Map([
        ['index.html', Buffer.from('<main>Current customer content</main>')],
        ['errors/not-found.html', Buffer.from('<h1>Not found</h1>')],
      ]),
    snapshot: { siteOrigin: policy.siteOrigin, products: [] },
    blogDelivery: 'server',
  });
  const run = {
    repository: policy.repository,
    workflowPath: policy.workflowPath,
    event: 'workflow_dispatch',
    ref: policy.trustedRef,
    headSha: codeSha,
    runId,
    artifact: {
      id: artifactId,
      runId,
      expired: false,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };
  return siteArtifact({ directory, policy, run });
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'site-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = payload(root);
  const records = new Map();
  const db = {
    collection: (name) => {
      assert.equal(name, 'catalogSeoArchives');
      return {
        doc: (id) => ({
          get: async () => ({ data: records.has(id) ? [{ ...records.get(id), _id: id }] : [] }),
          set: async (data) => {
            records.set(id, structuredClone(data));
            return { id };
          },
        }),
      };
    },
  };
  const blobs = new Map();
  const versions = new Map();
  const calls = [];
  let version = 0;
  const objects = {
    async put(bytes) {
      const digest = sha256(bytes);
      const ref = {
        fileID: `cloud://fixture-env.bucket/seo-recovery/objects/${digest}.bin`,
        sha256: digest,
        bytes: bytes.length,
      };
      blobs.set(ref.fileID, Buffer.from(bytes));
      versions.set(ref.fileID, `"v${++version}"`);
      calls.push(['put', ref]);
      return ref;
    },
    async get(ref) {
      calls.push(['get', ref]);
      const body = blobs.get(ref.fileID);
      if (!body) throw Error('Object missing');
      return Buffer.from(body);
    },
    async stat(ref) {
      calls.push(['stat', ref]);
      const body = blobs.get(ref.fileID);
      if (!body) throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
      return { bytes: body.length, etag: versions.get(ref.fileID) };
    },
  };
  const events = [];
  const retention = createSiteRetention({ db, objects, policy, onEvent: (e) => events.push(e) });
  const count = (name) => calls.filter((c) => c[0] === name).length;
  return { root, input, records, retention, blobs, versions, calls, count, objects, db, events };
}
test('a real verified payload is zipped, read back and retained independently of Actions expiry', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  assert.deepEqual([...x.records.keys()], ['site-v2-111']);
  const saved = x.records.get('site-v2-111');
  assert.equal(saved.schemaVersion, 2);
  assert.ok(saved.objects.every((item) => item.object.fileID.startsWith('cloud://fixture-env.')));
  assert.equal(x.count('put'), saved.objects.length);
  assert.equal(x.count('get'), 0, 'every upload is read back inside put, not again by save');
  const directory = join(x.root, 'restored');
  const run = await x.retention.download('111', directory);
  assert.equal(
    readFileSync(join(directory, 'index.html'), 'utf8'),
    '<main>Current customer content</main>',
  );
  assert.equal(retainedSiteProof(run.retainedProof, x.input.envelope), true);
  const future = Date.parse(run.artifact.expiresAt) + 1;
  const restored = siteArtifact({
    directory,
    policy,
    run,
    retainedProof: run.retainedProof,
    now: future,
  });
  assert.equal(restored.envelope.releaseId, x.input.envelope.releaseId);
  assert.throws(() => siteArtifact({ directory, policy, run, now: future }), /expired/);
  assert.throws(
    () =>
      siteArtifact({
        directory,
        policy,
        run,
        retainedProof: { ...run.retainedProof },
        now: future,
      }),
    /Unverified/,
  );
});
test('a missing registry entry uses no guessed public release or network request', async (t) => {
  const x = setup(t);
  assert.equal(await x.retention.download('111', join(x.root, 'absent')), null);
  assert.equal(x.calls.length, 0);
});
test('changed remote bytes stop before extraction and never overwrite the approved record', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  const previous = structuredClone(x.records.get('site-v2-111'));
  const id = previous.objects.find((item) => item.key === 'head').object.fileID;
  const body = Buffer.from(x.blobs.get(id));
  body[body.length - 1] ^= 1;
  x.blobs.set(id, body);
  const target = join(x.root, 'corrupt');
  await assert.rejects(x.retention.download('111', target), /ZIP differs/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(x.records.get('site-v2-111'), previous);
});
test('archive source and native registry must agree', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  x.records.get('site-v2-111').codeSha = 'b'.repeat(40);
  await assert.rejects(
    x.retention.download('111', join(x.root, 'wrong-source')),
    /payload identity differs/,
  );
});
test('a different manifest cannot borrow the trusted ZIP', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  x.records.get('site-v2-111').manifestSha256 = '0'.repeat(64);
  await assert.rejects(
    x.retention.download('111', join(x.root, 'wrong-manifest')),
    /payload identity differs/,
  );
});
test('a later run with the same pages uploads only its head and reuses the rest by version', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  const first = x.records.get('site-v2-111');
  const fresh = createSiteRetention({
    db: x.db,
    objects: x.objects,
    policy,
    onEvent: (e) => x.events.push(e),
  });
  await fresh.download('111', join(x.root, 'baseline'));
  assert.deepEqual(
    { ...x.events.at(-1), elapsedMs: 0 },
    {
      action: 'loaded',
      schemaVersion: 2,
      objects: first.objects.length,
      bytes: first.bytes,
      elapsedMs: 0,
    },
  );
  const puts = x.count('put');
  await fresh.save(payload(x.root, { runId: '102', artifactId: '112' }));
  const second = x.records.get('site-v2-112');
  assert.equal(x.count('put') - puts, 1);
  const changed = second.objects.filter(
    (item, n) => item.object.fileID !== first.objects[n].object.fileID,
  );
  assert.deepEqual(
    changed.map((item) => item.key),
    ['head'],
  );
  assert.deepEqual(x.events.at(-1), {
    ...x.events.at(-1),
    reused: first.objects.length - 1,
    uploaded: 1,
  });
  const restored = await fresh.download('112', join(x.root, 'second'));
  assert.equal(restored.retainedProof.releaseId, 'site-102-1');
  assert.equal(
    readFileSync(join(x.root, 'second', 'index.html'), 'utf8'),
    '<main>Current customer content</main>',
  );
});
test('a rewritten object is read in full before reuse; an absent one is uploaded again', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  const first = x.records.get('site-v2-111');
  const page = first.objects.find((item) => item.key !== 'head');
  x.versions.set(page.object.fileID, '"rewritten"');
  const gets = x.count('get');
  await x.retention.save(payload(x.root, { runId: '102', artifactId: '112' }));
  assert.equal(x.count('get') - gets, 1);
  const second = x.records.get('site-v2-112');
  assert.equal(second.objects.find((item) => item.key === page.key).etag, '"rewritten"');
  const other = first.objects.find((item) => item.key !== 'head' && item.key !== page.key);
  x.blobs.delete(other.object.fileID);
  const puts = x.count('put');
  await x.retention.save(payload(x.root, { runId: '103', artifactId: '113' }));
  assert.equal(x.count('put') - puts, 2, 'head and the absent object');
  assert.ok(x.blobs.has(other.object.fileID), 'the same bytes repair the shared key');
  await x.retention.download('111', join(x.root, 'repaired'));
});
test('records written by schema 1 still restore', async (t) => {
  const x = setup(t);
  const file = join(x.root, 'v1.zip');
  execFileSync('python3', [
    new URL('./release/pack-site-payload.py', import.meta.url).pathname,
    x.input.directory,
    file,
  ]);
  const archive = readFileSync(file);
  const archiveObject = await x.objects.put(archive);
  const e = x.input.envelope;
  x.records.set('111', {
    schemaVersion: 1,
    artifactId: '111',
    releaseId: e.releaseId,
    codeSha: e.codeSha,
    target: e.target,
    manifestSha256: e.artifact.manifestSha256,
    archiveSha256: archiveObject.sha256,
    bytes: archive.length,
    repository: policy.repository,
    archiveObject,
    run: x.input.run,
  });
  const run = await x.retention.download('111', join(x.root, 'v1'));
  assert.equal(retainedSiteProof(run.retainedProof, e), true);
  await x.retention.save(x.input);
  assert.equal(
    x.records.has('site-v2-111'),
    false,
    'an existing schema 1 record is kept, not rewritten',
  );
});
test('a record whose objects differ from the plan in its own manifest is refused', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  const record = x.records.get('site-v2-111');
  record.objects.find((item) => item.key !== 'head').contentSha256 = '0'.repeat(64);
  await assert.rejects(x.retention.download('111', join(x.root, 'drift')), /plan differs/);
  record.layout = { ...record.layout, version: 9 };
  await assert.rejects(x.retention.download('111', join(x.root, 'layout')), /layout/);
});
test('the same artifact is saved once and never replaced', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  const puts = x.count('put');
  await x.retention.save(x.input);
  assert.equal(x.count('put'), puts);
  x.records.get('site-v2-111').manifestSha256 = '0'.repeat(64);
  await assert.rejects(x.retention.save(x.input), /cannot be replaced/);
});
test('uploads keep about eight 1 MiB parts in flight; a large multipart object goes alone', async () => {
  assert.deepEqual(
    [1, 1024 * 1024, 1024 * 1024 + 1, 15 * 1024 * 1024].map(uploadParts),
    [1, 1, 2, 8],
  );
  let inFlight = 0;
  let peak = 0;
  const alone = [];
  const parts = [8, 1, 1, 2, 8, 1, 1, 1, 1, 1, 1, 1, 1];
  await mapByParts(
    parts,
    (p) => p,
    async (p) => {
      inFlight += p;
      peak = Math.max(peak, inFlight);
      if (p === 8) alone.push(inFlight === 8);
      await new Promise((done) => setTimeout(done, 5));
      inFlight -= p;
    },
  );
  assert.equal(peak, 8);
  assert.deepEqual(alone, [true, true]);
  await assert.rejects(
    mapByParts(
      [1, 1, 1],
      () => 1,
      async (p) => {
        throw Error(`failed ${p}`);
      },
    ),
    /failed 1/,
  );
});
test('a failed object upload is tried once more; a second failure stops before any record', async (t) => {
  const x = setup(t);
  const put = x.objects.put;
  let failures = 1;
  x.objects.put = async (bytes) => {
    if (failures-- > 0) throw Object.assign(Error('timed out'), { code: 'ETIMEDOUT' });
    return put(bytes);
  };
  await x.retention.save(x.input);
  assert.ok(x.records.has('site-v2-111'));
  assert.ok(x.events.some((e) => e.action === 'put-retried' && e.cause === 'ETIMEDOUT'));
  const y = setup(t);
  y.objects.put = async () => {
    throw Error('upload needs readback');
  };
  await assert.rejects(y.retention.save(y.input), /needs readback/);
  assert.equal(y.records.size, 0);
});
test('the delivery archive client runs as many files at once as retention moves', () => {
  assert.ok(PARALLEL_ARCHIVE_COS_OPTIONS.FileParallelLimit >= UPLOAD_PART_BUDGET);
  assert.ok(PARALLEL_ARCHIVE_COS_OPTIONS.FileParallelLimit >= 8, 'downloads run 8 at a time');
  assert.equal(PARALLEL_ARCHIVE_COS_OPTIONS.Timeout, ARCHIVE_COS_OPTIONS.Timeout);
});
