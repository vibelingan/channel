import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { assertDummyCleanup } from './release-drill/cleanup.mjs';
const seedRun = '40267380016';
const snapshot = {
  name: 'seo-release-dummy',
  functionId: 'lam-d42kr5c9',
  packageSha256: 'a'.repeat(64),
  runtime: 'Nodejs20.19',
  handler: 'index.main',
  triggerCount: 0,
  role: 'TCB_QcsRole',
  layers: [],
};
const health = { purpose: 'channel-recovery-dummy-v1', version: 'A', runId: seedRun };
const rows = ['existing', 'new-b', 'deleted-b'].map((s) => ({
  _id: `seo-drill-${seedRun}-${s}`,
  purpose: health.purpose,
  deleted: s === 'deleted-b',
}));
test('cleanup permits only the finished owned fixture and cannot choose other functions or rows', () => {
  const input = { seedRun, snapshot, health, rows, expectedHash: snapshot.packageSha256 };
  assertDummyCleanup(input);
  for (const bad of [
    { ...input, seedRun: 'other' },
    { ...input, snapshot: { ...snapshot, functionId: 'foreign' } },
    { ...input, snapshot: { ...snapshot, name: 'admin' } },
    { ...input, snapshot: { ...snapshot, triggerCount: 1 } },
    { ...input, expectedHash: 'b'.repeat(64) },
    { ...input, health: { ...health, version: 'B' } },
    { ...input, rows: rows.slice(0, 2) },
    { ...input, rows: [...rows, rows[0]] },
    { ...input, rows: rows.map((r) => ({ ...r, purpose: 'customer' })) },
    { ...input, rows: rows.map((r) => ({ ...r, deleted: false })) },
  ])
    assert.throws(() => assertDummyCleanup(bad));
});

test('partial cleanup keeps its exact last stage and deletion counts even when the job fails', async () => {
  const workflow = parse(await readFile('.github/workflows/seo-dummy-recovery.yml', 'utf8'));
  const keep = workflow.jobs.drill.steps.find((s) => s.uses === 'actions/upload-artifact@v4');
  assert.equal(keep.if, 'always()');
  assert.deepEqual(keep.with.path.trim().split('\n'), [
    'output/recovery-drill/result.json',
    'output/recovery-drill/cleanup-result.json',
  ]);
});
