import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from './release/input.mjs';
import { normalizePolicy } from './release/ledger.mjs';
import {
  assertDirtySiteInventory,
  assertJournaledSiteCandidate,
} from './release/site-recovery.mjs';
const policy = {
  repository: 'fixture/channel',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
};
function source(t, text, path = 'index.html') {
  const directory = mkdtempSync(join(tmpdir(), 'dirty-site-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const b = Buffer.from(text);
  writeFileSync(join(directory, path), b);
  return { directory, staticManifest: { entries: [{ path, bytes: b.length, sha256: sha256(b) }] } };
}
const inventory = (text, path = 'index.html') => [
  {
    path,
    bytes: Buffer.byteLength(text),
    etag: createHash('md5').update(text).digest('hex'),
    lastModified: '2026-10-24T00:00:00Z',
  },
];
for (const body of ['A', 'B'])
  test(`dirty recovery accepts exact ${body} and preserves outside ownership`, (t) => {
    const a = source(t, 'A');
    const b = source(t, 'B');
    assert.doesNotThrow(() =>
      assertDirtySiteInventory({
        baseline: a,
        failed: b,
        inventory: [...inventory(body), ...inventory('foreign', 'foreign.html')],
      }),
    );
  });
test('dirty recovery refuses an unrelated operator change and missing common page', (t) => {
  const a = source(t, 'A');
  const b = source(t, 'B');
  for (const live of [inventory('foreign'), []])
    assert.throws(() => assertDirtySiteInventory({ baseline: a, failed: b, inventory: live }));
});
test('a new candidate page may still be absent, but an existing candidate page must match B', (t) => {
  const a = source(t, 'A');
  const b = source(t, 'B', 'new.html');
  assert.doesNotThrow(() =>
    assertDirtySiteInventory({ baseline: a, failed: b, inventory: inventory('A') }),
  );
  assert.throws(() =>
    assertDirtySiteInventory({
      baseline: a,
      failed: b,
      inventory: [...inventory('A'), ...inventory('other', 'new.html')],
    }),
  );
});
test('failed artifact identity cannot authorize another run, target, accepted version or package', () => {
  const artifact = { artifactId: '1' };
  const input = {
    envelope: { artifact, codeSha: 'a'.repeat(40), releaseId: 'B' },
    acceptedSeal: null,
  };
  const run = {
    runId: 'B',
    state: 'FAILED',
    targetId: normalizePolicy(policy).targetId,
    scopeKey: 'site',
    accepted: null,
    composition: { static: { artifact, codeSha: 'a'.repeat(40), releaseId: 'B' } },
  };
  assert.doesNotThrow(() => assertJournaledSiteCandidate({ run, input, policy, dirtyRunId: 'B' }));
  for (const patch of [
    { runId: 'C' },
    { state: 'RUNNING' },
    { targetId: 'foreign' },
    { accepted: {} },
    { scopeKey: 'canary' },
    { composition: { static: { artifact: { artifactId: '2' } } } },
  ])
    assert.throws(() =>
      assertJournaledSiteCandidate({ run: { ...run, ...patch }, input, policy, dirtyRunId: 'B' }),
    );
});
