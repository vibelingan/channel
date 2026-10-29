import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { catalogPublicRecordId } from './catalog-public-changes.ts';
import { type CatalogSeoDatabase, createCatalogSeoStore } from './catalog-seo-cloud.ts';
import {
  CatalogSeoControlSchema,
  catalogSeoControlId,
  idleCatalogSeoControl,
} from './catalog-seo-control.ts';
import { CatalogSeoWriteBusyError, planCatalogSeoWrite } from './catalog-seo-control.ts';
import {
  CatalogSeoDeliveryChangedError,
  createCatalogSeoDelivery,
} from './catalog-seo-delivery.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';
const site = 'https://shop.example';
const now = '2026-10-30T00:00:00.000Z';
function native(value: unknown): asserts value is CatalogSeoDatabase {
  assert.ok(value && typeof value === 'object');
  assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
  assert.equal(typeof Reflect.get(value, 'collection'), 'function');
  assert.equal(typeof Reflect.get(Reflect.get(value, 'command'), 'gt'), 'function');
}
function seed(f: ReturnType<typeof articleSdkFixture>) {
  const id = catalogPublicRecordId(site, 'p');
  f.put('catalogPublicHeads', id, {
    _id: id,
    schemaVersion: 1,
    siteOrigin: site,
    productId: 'p',
    sequence: 2,
    visible: true,
    semanticHash: 'a'.repeat(64),
    detailRevision: null,
    changedAt: now,
    latestEventId: 'b'.repeat(64),
  });
  f.put('catalogSeoTasks', id, {
    _id: id,
    schemaVersion: 1,
    siteOrigin: site,
    productId: 'p',
    requestedSequence: 2,
    acceptedSequence: 1,
    state: 'pending',
    attempts: 0,
    lease: null,
  });
  return id;
}
test('installed SDK holds the affected product through upload and readback, then accepts only its real version', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  const store = createCatalogSeoStore(db);
  const delivery = createCatalogSeoDelivery(store, site, 0, 'run', () => now);
  const ticket = await delivery.begin(['p']);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.state, 'writing');
  const request = createCatalogSeoRequest(
    site,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    now,
  );
  await assert.rejects(
    store.transaction((tx) =>
      planCatalogSeoWrite(tx, { siteOrigin: site, detailEnabled: true }, [], [request], now),
    ),
    CatalogSeoWriteBusyError,
  );
  await delivery.end(ticket, 'verified');
  await delivery.check();
  await delivery.accept([{ productId: 'p', htmlSha256: 'c'.repeat(64) }]);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.acceptedSequence, 2);
  assert.equal(f.rows.get(`catalogSeoPages/${id}`)?.ready, true);
  assert.equal(f.rows.get(`catalogSeoControl/${catalogSeoControlId(site)}`)?.state, 'idle');
});
test('changed public data stops a candidate before its first write and before final acceptance', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  seed(f);
  const store = createCatalogSeoStore(db);
  const delivery = createCatalogSeoDelivery(store, site, 0, 'run', () => now);
  f.put('catalogSeoControl', catalogSeoControlId(site), {
    ...idleCatalogSeoControl(site, now),
    writes: 1,
  });
  await assert.rejects(delivery.begin(['p']), CatalogSeoDeliveryChangedError);
  await assert.rejects(delivery.check(), CatalogSeoDeliveryChangedError);
  assert.equal(f.rows.get(`catalogSeoTasks/${catalogPublicRecordId(site, 'p')}`)?.state, 'pending');
});
test('unknown storage result remains blocked after time passes; another runner cannot take over', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  seed(f);
  const store = createCatalogSeoStore(db);
  const delivery = createCatalogSeoDelivery(store, site, 0, 'run', () => now);
  const ticket = await delivery.begin(['p']);
  await delivery.end(ticket, 'unknown');
  const later = createCatalogSeoDelivery(store, site, 0, 'later', () => '2026-11-01T00:00:00.000Z');
  await assert.rejects(later.begin(['p']), CatalogSeoDeliveryChangedError);
  assert.equal(
    f.rows.get(`catalogSeoControl/${catalogSeoControlId(site)}`)?.state,
    'needs-readback',
  );
});
test('a failed task write rolls back the delivery ownership and all partial changes', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  f.control.zeroWriteCollection = 'catalogSeoTasks';
  await assert.rejects(
    createCatalogSeoDelivery(createCatalogSeoStore(db), site, 0, 'run', () => now).begin(['p']),
    /not acknowledged/,
  );
  assert.equal(f.rows.has(`catalogSeoControl/${catalogSeoControlId(site)}`), false);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.state, 'pending');
});
test('active ownership requires both its owner and deadline, and duplicate targets are rejected', () => {
  const row = {
    ...idleCatalogSeoControl(site, now),
    state: 'writing',
    owner: 'run',
    until: now,
    products: ['p'],
  };
  assert.equal(CatalogSeoControlSchema.safeParse(row).success, true);
  for (const bad of [
    { ...row, owner: null },
    { ...row, until: null },
    { ...row, products: ['p', 'p'] },
  ])
    assert.equal(CatalogSeoControlSchema.safeParse(bad).success, false);
});

test('a known failed delivery can retry its task, while an unknown cloud outcome cannot', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  const store = createCatalogSeoStore(db);
  const delivery = createCatalogSeoDelivery(store, site, 0, 'run', () => now);
  const ticket = await delivery.begin(['p']);
  await assert.rejects(delivery.retryKnownFailure(), /Unknown/);
  await delivery.end(ticket, 'verified');
  await delivery.retryKnownFailure();
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.state, 'pending');
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.lease, null);
  const next = createCatalogSeoDelivery(store, site, 0, 'new-run', () => now);
  const held = await next.begin(['p']);
  await next.end(held, 'unknown');
  await assert.rejects(next.retryKnownFailure(), /Unknown/);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.state, 'writing');
});
