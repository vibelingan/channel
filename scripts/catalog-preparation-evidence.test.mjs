import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadCatalogPreparationEvidence } from './release/catalog-preparation-evidence.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-prep-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = {
    id: 41303614689,
    run_attempt: 1,
    head_sha: 'a'.repeat(40),
    repository: { full_name: 'vibelingan/channel' },
  };
  const artifactName = `site-delivery-evidence-${run.id}-1`;
  const metadata = {
    id: 123,
    name: artifactName,
    size_in_bytes: 1363,
    expired: false,
    digest: `sha256:${'b'.repeat(64)}`,
    workflow_run: { id: run.id, head_sha: run.head_sha },
  };
  const receipt = { schemaVersion: 1, purpose: 'catalog-seo-regional-v1' };
  const f = { downloads: 0, metadata, receipt, rows: [metadata] };
  const github = { api: async () => ({ total_count: f.rows.length, artifacts: f.rows }) };
  const artifacts = {
    async downloadArtifact(id, options) {
      f.downloads++;
      assert.equal(id, metadata.id);
      assert.equal(options.expectedHash, `sha256:${'b'.repeat(64)}`);
      assert.deepEqual(options.findBy, {
        token: 'private-read-token',
        workflowRunId: run.id,
        repositoryOwner: 'vibelingan',
        repositoryName: 'channel',
      });
      await mkdir(join(options.path, 'regional'));
      await writeFile(join(options.path, 'regional/result.json'), JSON.stringify(receipt));
      await mkdir(join(options.path, 'release-regional'));
      await writeFile(
        join(options.path, 'release-regional/result.json'),
        JSON.stringify({ ...receipt, purpose: 'release-regional-v1' }),
      );
      return { downloadPath: options.path, digestMismatch: false, ...f.downloadResult };
    },
  };
  f.options = {
    github,
    artifacts,
    token: 'private-read-token',
    directory,
    run,
    artifactName,
    regionalPath: 'regional/result.json',
  };
  return f;
}

test('the exact original receipt is read only after source, size and archive hash checks', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await loadCatalogPreparationEvidence(f.options), f.receipt);
  assert.equal(f.downloads, 1);
});

test('the stopped preparation may also read its fixed release ledger receipt', async (t) => {
  const f = await fixture(t);
  f.options.regionalPath = 'release-regional/result.json';
  assert.deepEqual(await loadCatalogPreparationEvidence(f.options), {
    ...f.receipt,
    purpose: 'release-regional-v1',
  });
  assert.equal(f.downloads, 1);
});

for (const [name, change] of [
  [
    'foreign repository',
    (f) => {
      f.options.run.repository.full_name = 'other/app';
    },
  ],
  [
    'foreign artifact source',
    (f) => {
      f.metadata.workflow_run.head_sha = 'c'.repeat(40);
    },
  ],
  [
    'foreign run',
    (f) => {
      f.metadata.workflow_run.id++;
    },
  ],
  [
    'expired receipt',
    (f) => {
      f.metadata.expired = true;
    },
  ],
  [
    'oversized receipt',
    (f) => {
      f.metadata.size_in_bytes = 1024 * 1024 + 1;
    },
  ],
  [
    'missing digest',
    (f) => {
      f.metadata.digest = undefined;
    },
  ],
  [
    'missing receipt',
    (f) => {
      f.rows = [];
    },
  ],
  [
    'duplicate receipt',
    (f) => {
      f.rows.push({ ...f.metadata, id: 456 });
    },
  ],
  [
    'path traversal',
    (f) => {
      f.options.regionalPath = '../regional/result.json';
    },
  ],
  [
    'arbitrary artifact member',
    (f) => {
      f.options.regionalPath = 'result.json';
    },
  ],
]) {
  test(`${name} cannot be used as preparation proof`, async (t) => {
    const f = await fixture(t);
    change(f);
    await assert.rejects(loadCatalogPreparationEvidence(f.options));
    assert.equal(f.downloads, 0);
  });
}

test('a downloaded archive with an unconfirmed or mismatched digest is rejected', async (t) => {
  for (const digestMismatch of [true, undefined]) {
    const f = await fixture(t);
    f.downloadResult = { digestMismatch };
    await assert.rejects(loadCatalogPreparationEvidence(f.options));
    assert.equal(f.downloads, 1);
  }
});

test('a wrong download directory and stale destination are rejected', async (t) => {
  const f = await fixture(t);
  f.downloadResult = { downloadPath: tmpdir() };
  await assert.rejects(loadCatalogPreparationEvidence(f.options));
  await assert.rejects(loadCatalogPreparationEvidence(f.options));
  assert.equal(f.downloads, 1);
});
