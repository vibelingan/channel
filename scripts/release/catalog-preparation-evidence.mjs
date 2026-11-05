import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readObject } from './input.mjs';

/** Download only the exact completed run's small preparation receipt, never a site payload. */
export async function loadCatalogPreparationEvidence({
  github,
  artifacts,
  token,
  directory,
  run,
  artifactName,
  regionalPath,
}) {
  assert.equal(run.repository?.full_name, 'vibelingan/channel');
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  assert.match(run.head_sha ?? '', /^[a-f0-9]{40}$/);
  assert.equal(artifactName, `site-delivery-evidence-${run.id}-${run.run_attempt}`);
  assert.ok(
    ['regional/result.json', 'release-regional/result.json'].includes(regionalPath),
    'Only the two fixed regional receipts may be used as preparation proof',
  );
  assert.equal(typeof token, 'string');
  assert.ok(token);
  const rows = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const result = await github.api(`/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
    assert.ok(Number.isSafeInteger(result.total_count) && result.total_count <= 1000);
    assert.ok(Array.isArray(result.artifacts) && result.artifacts.length <= 100);
    assert.ok(total === undefined || total === result.total_count);
    total = result.total_count;
    rows.push(...result.artifacts);
    if (rows.length === total) break;
    assert.equal(result.artifacts.length, 100);
    assert.ok(rows.length < total);
  }
  assert.equal(rows.length, total);
  const selected = rows.filter((row) => row.name === artifactName);
  assert.equal(selected.length, 1, 'Exact preparation evidence is missing or ambiguous');
  const artifact = selected[0];
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  assert.equal(artifact.expired, false);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes));
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 1024 * 1024);
  assert.equal(artifact.workflow_run?.id, run.id);
  assert.equal(artifact.workflow_run.head_sha, run.head_sha);
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  const destination = resolve(directory, `${run.id}-${run.run_attempt}`);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 });
  const result = await artifacts.downloadArtifact(artifact.id, {
    path: destination,
    expectedHash: artifact.digest,
    findBy: {
      token,
      workflowRunId: run.id,
      repositoryOwner: 'vibelingan',
      repositoryName: 'channel',
    },
  });
  assert.equal(result.digestMismatch, false, 'Preparation artifact hash was not confirmed');
  assert.equal(resolve(result.downloadPath ?? ''), destination);
  return JSON.parse(readObject(destination, regionalPath, 512 * 1024).toString('utf8'));
}
