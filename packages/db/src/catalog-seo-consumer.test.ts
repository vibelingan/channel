import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type CatalogSeoStore, consumeCatalogSeoRequest } from './catalog-seo-consumer.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';

const config = { siteOrigin: 'https://shop.example', detailEnabled: true };
const now = '2026-10-29T13:00:00.000Z';
function fixture() {
  let rows = new Map<string, CollectionDoc>();
  let failWrite: string | undefined;
  let beforeTransaction: (() => void) | undefined;
  const get = async (collection: string, id: string) =>
    structuredClone(rows.get(`${collection}/${id}`) ?? null);
  const db: CatalogSeoStore = {
    get,
    list: async (collection, filter, cursor, limit) =>
      [...rows.entries()]
        .filter(
          ([key, row]) =>
            key.startsWith(`${collection}/`) &&
            row._id > (cursor ?? '') &&
            Object.entries(filter).every(([k, v]) => row[k] === v),
        )
        .map(([, row]) => structuredClone(row))
        .sort((a, b) => (a._id < b._id ? -1 : 1))
        .slice(0, limit),
    transaction: async (fn) => {
      beforeTransaction?.();
      beforeTransaction = undefined;
      const copy = structuredClone(rows);
      let writing = false;
      const result = await fn({
        get: async (collection, id) => {
          assert.equal(writing, false, 'read before writes');
          return structuredClone(copy.get(`${collection}/${id}`) ?? null);
        },
        set: async (collection, row) => {
          writing = true;
          if (collection === failWrite) throw Error('refused write');
          copy.set(`${collection}/${row._id}`, structuredClone(row));
        },
      });
      rows = copy;
      return result;
    },
  };
  const product = { _id: 'p', name: 'Headset', published: true, productFamily: 'misc' };
  const request = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    now,
  );
  rows.set('products/p', product);
  rows.set(`catalogSeoRequests/${request._id}`, request);
  return {
    db,
    request,
    put: (c: string, row: CollectionDoc) => rows.set(`${c}/${row._id}`, structuredClone(row)),
    read: get,
    fail: (c: string) => {
      failWrite = c;
    },
    before: (fn: () => void) => {
      beforeTransaction = fn;
    },
  };
}

test('an actual pending request creates an explicitly untracked first version and pending delivery task', async () => {
  const h = fixture();
  const result = await consumeCatalogSeoRequest(h.db, h.request, config, now);
  assert.equal(result.status, 'checked');
  assert.equal(result.kind, 'initialized');
  assert.equal((await h.read('catalogSeoRequests', h.request._id))?.state, 'checked');
  const heads = await h.db.list('catalogPublicHeads', {}, null, 20);
  const tasks = await h.db.list('catalogSeoTasks', {}, null, 20);
  assert.equal(heads.length, 1);
  assert.equal(heads[0]?.changedAt, null);
  assert.equal(tasks[0]?.state, 'pending');
  assert.equal(tasks[0]?.requestedSequence, 1);
});

test('failure while writing the delivery task leaves the original request pending and no head', async () => {
  const h = fixture();
  h.fail('catalogSeoTasks');
  await assert.rejects(consumeCatalogSeoRequest(h.db, h.request, config, now), /refused write/);
  assert.equal((await h.read('catalogSeoRequests', h.request._id))?.state, 'pending');
  assert.deepEqual(await h.db.list('catalogPublicHeads', {}, null, 20), []);
});

test('a newer request arriving after the full read cannot be acknowledged by the old consumer', async () => {
  const h = fixture();
  const next = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    now,
  );
  h.before(() => h.put('catalogSeoRequests', next));
  const result = await consumeCatalogSeoRequest(h.db, h.request, config, now);
  assert.equal(result.status, 'stale');
  assert.deepEqual(await h.read('catalogSeoRequests', next._id), next);
  assert.deepEqual(await h.db.list('catalogPublicHeads', {}, null, 20), []);
});

test('real public changes advance the version with the save time, and identical retries do not', async () => {
  const h = fixture();
  await consumeCatalogSeoRequest(h.db, h.request, config, now);
  const savedAt = '2026-10-29T14:00:00.000Z';
  const next = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    savedAt,
  );
  h.put('products', { _id: 'p', name: 'New headset', published: true, productFamily: 'misc' });
  h.put('catalogSeoRequests', next);
  const result = await consumeCatalogSeoRequest(h.db, next, config, '2026-10-29T15:00:00.000Z');
  assert.ok(result.status === 'checked');
  assert.equal(result.kind, 'changed');
  assert.equal(result.sequence, 2);
  const heads = await h.db.list('catalogPublicHeads', {}, null, 20);
  assert.equal(heads[0]?.changedAt, savedAt);
  assert.deepEqual(
    await consumeCatalogSeoRequest(h.db, { ...next, state: 'checked' }, config, now),
    { status: 'already-checked' },
  );
});

test('reapproving identical content updates only the opaque revision and preserves its delivery lease', async () => {
  const h = fixture();
  const header = {
    _id: 'p',
    schemaVersion: 'catalog-product-detail-v1',
    name: 'Headset',
    images: [],
    facts: [],
    offers: [],
  };
  const publication = {
    state: 'approved',
    revision: 'r1',
    variantCount: 0,
    variantStorage: 'immutable-v1',
    header,
  };
  const product = {
    _id: 'p',
    name: 'Headset',
    published: true,
    productFamily: 'misc',
    catalogDetailPublication: publication,
  };
  h.put('products', product);
  await consumeCatalogSeoRequest(h.db, h.request, config, now);
  const task = (await h.db.list('catalogSeoTasks', {}, null, 20))[0];
  assert.ok(task);
  const held = {
    ...task,
    state: 'writing',
    attempts: 3,
    lease: { runId: 'worker', sequence: 1, until: '2026-10-29T15:00:00.000Z' },
  };
  h.put('catalogSeoTasks', held);
  h.put('products', { ...product, catalogDetailPublication: { ...publication, revision: 'r2' } });
  const next = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    now,
  );
  h.put('catalogSeoRequests', next);
  const result = await consumeCatalogSeoRequest(h.db, next, config, now);
  assert.ok(result.status === 'checked');
  assert.equal(result.kind, 'metadata');
  assert.equal(result.sequence, 1);
  assert.deepEqual((await h.db.list('catalogSeoTasks', {}, null, 20))[0], held);
  assert.equal((await h.db.list('catalogPublicHeads', {}, null, 20))[0]?.changedAt, null);
});

test('a withdrawal retains a nonvisible head and still requires verified removal from hosting', async () => {
  const h = fixture();
  await consumeCatalogSeoRequest(h.db, h.request, config, now);
  h.put('products', { _id: 'p', published: false });
  const next = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p', previouslyPublic: true },
    now,
  );
  h.put('catalogSeoRequests', next);
  await consumeCatalogSeoRequest(h.db, next, config, now);
  const heads = await h.db.list('catalogPublicHeads', {}, null, 20);
  assert.equal(heads[0]?.visible, false);
  assert.equal(heads[0]?.sequence, 2);
  assert.equal((await h.db.list('catalogSeoTasks', {}, null, 20))[0]?.state, 'pending');
});

test('category expansion is bounded, resumes its cursor, and never replaces a newer product request', async () => {
  const h = fixture();
  for (let i = 0; i < 45; i++)
    h.put('products', {
      _id: `z-${String(i).padStart(3, '0')}`,
      name: 'Product',
      published: true,
      productFamily: 'misc',
    });
  h.put('products', { _id: 'z-private', published: false, productFamily: 'misc' });
  h.put('products', { _id: 'z-other', published: true, productFamily: 'toys' });
  const existing = h.request;
  const family = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'family', family: 'misc' },
    now,
  );
  assert.ok(family.kind === 'family');
  h.put('catalogSeoRequests', family);
  let current = family;
  let count = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await consumeCatalogSeoRequest(h.db, current, config, now);
    assert.ok(result.status === 'expanded');
    assert.ok(result.queued <= 20);
    count += result.queued;
    const row = await h.read('catalogSeoRequests', family._id);
    assert.ok(row);
    if (result.complete) {
      assert.equal(row.state, 'checked');
      break;
    }
    current = Object.assign({}, current, row);
  }
  assert.equal(count, 45);
  assert.deepEqual(await h.read('catalogSeoRequests', existing._id), existing);
  assert.equal((await h.db.list('catalogSeoRequests', { kind: 'product' }, null, 100)).length, 46);
});

test('a newer classification read prevents confirming an older prepared product', async () => {
  const h = fixture();
  h.before(() =>
    h.put('catalogTaxonomies', {
      _id: 'misc',
      family: 'misc',
      revision: 1,
      name: 'Changed family',
      children: [],
    }),
  );
  const result = await consumeCatalogSeoRequest(h.db, h.request, config, now);
  assert.equal(result.status, 'stale');
  assert.equal((await h.read('catalogSeoRequests', h.request._id))?.state, 'pending');
});
