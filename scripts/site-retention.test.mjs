import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration } from './release-hosting-fixtures.mjs';
import { sha256 } from './release/input.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
import { createSiteRetention, retainedSiteProof } from './release/site-retention.mjs';
const policy = {
  repository: 'vibelingan/channel',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
  workflowPath: '.github/workflows/seo-static-canary.yml',
  trustedRef: 'refs/heads/feat/seo-foundation',
};
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'site-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'candidate');
  const codeSha = 'a'.repeat(40);
  createSitePayload({
    directory,
    policy,
    configuration: configuration(),
    codeSha,
    releaseId: 'site-101-1',
    files: new Map([
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
    runId: '101',
    artifact: {
      id: '111',
      runId: '101',
      expired: false,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };
  const input = siteArtifact({ directory, policy, run });
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
  const calls = [];
  const objects = {
    async put(bytes) {
      const digest = sha256(bytes);
      const ref = {
        fileID: `cloud://fixture-env.bucket/seo-recovery/objects/${digest}.bin`,
        sha256: digest,
        bytes: bytes.length,
      };
      blobs.set(ref.fileID, Buffer.from(bytes));
      calls.push(['put', ref]);
      return ref;
    },
    async get(ref) {
      calls.push(['get', ref]);
      const body = blobs.get(ref.fileID);
      if (!body) throw Error('Object missing');
      return Buffer.from(body);
    },
  };
  const retention = createSiteRetention({ db, objects, policy });
  return { root, input, records, retention, blobs, calls };
}
test('a real verified payload is zipped, read back and retained independently of Actions expiry', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  assert.equal(x.records.size, 1);
  assert.ok(x.records.get('111').archiveObject.fileID.startsWith('cloud://fixture-env.'));
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
  const previous = structuredClone(x.records.get('111'));
  const id = x.records.get('111').archiveObject.fileID;
  const body = Buffer.from(x.blobs.get(id));
  body[body.length - 1] ^= 1;
  x.blobs.set(id, body);
  const target = join(x.root, 'corrupt');
  await assert.rejects(x.retention.download('111', target), /ZIP differs/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(x.records.get('111'), previous);
});
test('archive source and native registry must agree', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  x.records.get('111').codeSha = 'b'.repeat(40);
  await assert.rejects(
    x.retention.download('111', join(x.root, 'wrong-source')),
    /payload identity differs/,
  );
});
test('a different manifest cannot borrow the trusted ZIP', async (t) => {
  const x = setup(t);
  await x.retention.save(x.input);
  x.records.get('111').manifestSha256 = '0'.repeat(64);
  await assert.rejects(
    x.retention.download('111', join(x.root, 'wrong-manifest')),
    /payload identity differs/,
  );
});
