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
    createdAt: new Date().toISOString(),
    publication: publication('p-open', ['banner'], ['colour-red']),
  });
  await database.create('catalogDetailApprovals', {
    _id: 'job-done',
    productId: 'p-done',
    state: 'complete',
    createdAt: new Date().toISOString(),
    publication: publication('p-done', ['old-photo']),
  });
  return database;
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

test('an abandoned approval older than the approval limit no longer pins its photos', async (t) => {
  const database = await fixture(t);
  await database.create('catalogDetailApprovals', {
    _id: 'job-abandoned',
    productId: 'p-abandoned',
    state: 'staging',
    publication: publication('p-abandoned', ['left-behind']),
  });
  assert.equal(await unfinishedApprovalUsingImage('left-behind'), 'p-abandoned', 'still recent');
  // Over an hour old it can no longer finish, so a delete need not wait.
  await database.update('catalogDetailApprovals', 'job-abandoned', {
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(await unfinishedApprovalUsingImage('left-behind'), null);
});

test('jobs beyond the first page of 100 are checked too', async (t) => {
  const database = await fixture(t);
  for (let index = 0; index < 120; index += 1)
    await database.create('catalogDetailApprovals', {
      _id: `job-${String(index).padStart(3, '0')}`,
      productId: `p-${index}`,
      state: 'staging',
      createdAt: new Date().toISOString(),
      publication: publication(`p-${index}`, [`photo-${index}`]),
    });
  assert.equal(await unfinishedApprovalUsingImage('photo-119'), 'p-119');
});

for (const [ageMinutes, expected] of [
  [65, 'p-margin'],
  [69, 'p-margin'],
  [71, null],
] as const)
  test(`the original ten-minute deletion margin remains active at age ${ageMinutes} minutes`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-approval-margin-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const adapter = new JsonFileAdapter(join(dir, 'db.json'));
    const now = Date.parse('2026-10-18T00:00:00.000Z');
    t.mock.method(Date, 'now', () => now);
    await adapter.createDocWithId('catalogDetailApprovals', 'margin-job', {
      productId: 'p-margin',
      state: 'staging',
      createdAt: new Date(now - ageMinutes * 60 * 1000).toISOString(),
      publication: publication('p-margin', ['photo-margin']),
    });
    // createDocWithId preserves the explicit creation time on this fixture.
    setAdapter(adapter);
    assert.equal(await unfinishedApprovalUsingImage('photo-margin'), expected);
  });
