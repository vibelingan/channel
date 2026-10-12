/**
 * DEC-21: approval reads shared photos and never writes them, so delete paths
 * must find an unfinished approval that would publish a photo. Real local
 * adapter, real list filters.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setAdapter, unfinishedApprovalUsingImage } from '@vibelingan-channel/db';
import { JsonFileAdapter } from './json-adapter.ts';

function publication(productId: string, gallery: string[], variantImageIds: string[] = []) {
  return {
    state: 'approved',
    revision: 'r1',
    variantCount: 0,
    variantImageIds,
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: productId,
      name: 'Headset',
      images: gallery.map((id) => `/api/images/${id}`),
      facts: [],
      offers: [],
    },
  };
}

async function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-unfinished-approval-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new JsonFileAdapter(join(directory, 'db.json'));
  setAdapter(database);
  await database.create('catalogDetailApprovals', {
    _id: 'job-open',
    productId: 'p-open',
    state: 'staging',
    publication: publication('p-open', ['banner'], ['colour-red']),
  });
  await database.create('catalogDetailApprovals', {
    _id: 'job-done',
    productId: 'p-done',
    state: 'complete',
    publication: publication('p-done', ['old-photo']),
  });
}

test('an unfinished approval that would publish a photo is found, by gallery or configuration photo', async (t) => {
  await fixture(t);
  assert.equal(await unfinishedApprovalUsingImage('banner'), 'p-open');
  assert.equal(await unfinishedApprovalUsingImage('colour-red'), 'p-open');
});

test('finished approvals and unrelated photos do not block a delete', async (t) => {
  await fixture(t);
  assert.equal(
    await unfinishedApprovalUsingImage('old-photo'),
    null,
    'finished: the product lists it now',
  );
  assert.equal(await unfinishedApprovalUsingImage('unrelated'), null);
});
