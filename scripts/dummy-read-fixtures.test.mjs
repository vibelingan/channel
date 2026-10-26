import assert from 'node:assert/strict';
import test from 'node:test';
import { articleSdkFixture } from '../packages/db/src/article-sdk-fixture.test-helper.ts';
import { readDummyFixtures } from './release-drill/read-fixtures.mjs';
test('dummy recovery reads actual native SDK non-transaction doc.get array shapes', async (t) => {
  const f = articleSdkFixture(t);
  const id = 'seo-drill-123-existing';
  f.put('seoReleaseDrillFixtures', id, { purpose: 'channel-recovery-dummy-v1', label: 'A' });
  const rows = await readDummyFixtures(f.db, '123');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._id, id);
  assert.equal(rows[0].label, 'A');
});
