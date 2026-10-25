import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadDummyFunction } from '../release/dummy-recovery-fixture.mjs';
import { checkFunctionArchive } from '../release/function-archive.mjs';
import { buildLiveDummyFunction } from './build-function.mjs';
test('the actual SDK is bundled in the standalone live function; archived A still preserves B data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'live-dummy-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = await buildLiveDummyFunction({
    directory: join(root, 'A'),
    version: 'A',
    codeSha: 'a'.repeat(40),
  });
  const b = await buildLiveDummyFunction({
    directory: join(root, 'B'),
    version: 'B',
    codeSha: 'a'.repeat(40),
  });
  assert.notDeepEqual(a.bytes, b.bytes);
  checkFunctionArchive(a.bytes, { smoke: true });
  const loaded = loadDummyFunction(a.bytes);
  t.after(loaded.close);
  assert.equal((await loaded.main({ action: 'health' })).version, 'A');
  const record = {
    _id: 'seo-drill-example',
    purpose: 'channel-recovery-dummy-v1',
    label: 'B',
    note: 'keep new field',
    revision: 2,
    deleted: false,
  };
  const result = await loaded.main({
    action: 'update',
    id: record._id,
    record,
    patch: { label: 'A' },
  });
  assert.equal(result.record.note, 'keep new field');
  await assert.rejects(
    buildLiveDummyFunction({ directory: join(root, 'A'), version: 'A', codeSha: 'a'.repeat(40) }),
  );
});
