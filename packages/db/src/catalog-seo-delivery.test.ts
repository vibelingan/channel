import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { CatalogPublicHeadSchema, catalogPublicRecordId } from './catalog-public-changes.ts';
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
  createCatalogSeoDeliveryStateless,
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
test('captured heads can prime final acceptance without starting a delivery or changing attempts', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  const delivery = createCatalogSeoDelivery(createCatalogSeoStore(db), site, 0, 'run', () => now);
  const before = structuredClone(f.rows);
  delivery.primeExpectedHeads([f.rows.get(`catalogPublicHeads/${id}`)]);
  assert.deepEqual(f.rows, before);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(delivery.trackedProducts, ['p']);
  await delivery.accept([{ productId: 'p', htmlSha256: 'c'.repeat(64) }]);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.acceptedSequence, 2);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.attempts, 0);
});

test('separate installed SDK calls can begin, end and accept using the exact transaction result', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  const source = createCatalogSeoStore(db);
  const returned: unknown[] = [];
  const store = {
    ...source,
    transaction: <T>(operation: Parameters<typeof source.transaction<T>>[0]) =>
      source.transaction(async (tx) => {
        const result = await operation(tx);
        returned.push(structuredClone(result));
        return result;
      }),
  };
  const make = () => createCatalogSeoDeliveryStateless(store, site, 0, 'run', () => now);
  const prepared = await make().begin(['p']);
  assert.deepEqual(returned, [prepared]);
  assert.deepEqual(prepared.expectedHeads, [f.rows.get(`catalogPublicHeads/${id}`)]);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.attempts, 1);
  const ticket = JSON.parse(JSON.stringify(prepared.ticket));
  await make().end(ticket, 'verified');
  await make().accept([{ productId: 'p', htmlSha256: 'c'.repeat(64) }], prepared.expectedHeads);
  const accepted = structuredClone(f.rows.get(`catalogSeoPages/${id}`));
  const later = createCatalogSeoDeliveryStateless(
    store,
    site,
    0,
    'run',
    () => '2026-11-01T00:00:00.000Z',
  );
  await later.accept([{ productId: 'p', htmlSha256: 'c'.repeat(64) }], prepared.expectedHeads);
  assert.deepEqual(f.rows.get(`catalogSeoPages/${id}`), accepted);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.attempts, 1);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.state, 'accepted');
  assert.equal(f.calls.filter((call) => call.api === 'database.startTransaction').length, 4);
});

test('stateless end refuses a different run, owner, fence or product set without releasing control', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  seed(f);
  const store = createCatalogSeoStore(db);
  const core = createCatalogSeoDeliveryStateless(store, site, 0, 'run', () => now);
  const { ticket } = await core.begin(['p']);
  const held = structuredClone(f.rows);
  for (const bad of [
    { ...ticket, owner: 'run:unknown' },
    { ...ticket, owner: 'other:unknown' },
    { ...ticket, fence: ticket.fence + 1 },
    { ...ticket, fence: 0 },
    { ...ticket, products: [] },
    { ...ticket, products: ['other'] },
    { ...ticket, products: ['p', 'p'] },
  ]) {
    await assert.rejects(core.end(bad, 'verified'));
    assert.deepEqual(f.rows, held);
  }
  for (const run of ['r', 'other', 'run:sub'])
    await assert.rejects(
      createCatalogSeoDeliveryStateless(store, site, 0, run, () => now).end(ticket, 'verified'),
    );
  assert.deepEqual(f.rows, held);
  await createCatalogSeoDeliveryStateless(store, site, 0, 'run', () => now).end(ticket, 'unknown');
  assert.equal(
    f.rows.get(`catalogSeoControl/${catalogSeoControlId(site)}`)?.state,
    'needs-readback',
  );
});

test('priming validates every head before changing memory and never acquires a delivery ticket', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  const head = CatalogPublicHeadSchema.parse(f.rows.get(`catalogPublicHeads/${id}`));
  const delivery = createCatalogSeoDelivery(createCatalogSeoStore(db), site, 0, 'run', () => now);
  for (const rows of [
    [head, { ...head, productId: 'other' }],
    [{ ...head, siteOrigin: 'https://other.example' }],
    [{ ...head, _id: 'f'.repeat(64) }],
    [{ ...head, sequence: 0 }],
    [head, head],
  ]) {
    assert.throws(() => delivery.primeExpectedHeads(rows));
    assert.deepEqual(delivery.trackedProducts, []);
  }
  assert.equal(f.calls.length, 0);
  delivery.primeExpectedHeads([head]);
  const independent = createCatalogSeoDeliveryStateless(
    createCatalogSeoStore(db),
    site,
    0,
    'run',
    () => now,
  );
  const { ticket } = await independent.begin(['p']);
  await assert.rejects(delivery.end(ticket, 'verified'), /Unknown SEO delivery ticket/);
  await independent.end(ticket, 'verified');
});

test('explicit heads and the real control write fence prevent accepting stale product HTML', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  const head = CatalogPublicHeadSchema.parse(f.rows.get(`catalogPublicHeads/${id}`));
  const core = createCatalogSeoDeliveryStateless(
    createCatalogSeoStore(db),
    site,
    0,
    'run',
    () => now,
  );
  const pages = [{ productId: 'p', htmlSha256: 'c'.repeat(64) }];
  const before = structuredClone(f.rows);
  for (const heads of [[], [{ ...head, sequence: 1 }], [{ ...head, semanticHash: 'e'.repeat(64) }]])
    await assert.rejects(core.accept(pages, heads), CatalogSeoDeliveryChangedError);
  await assert.rejects(core.accept(pages, [{ ...head, _id: 'f'.repeat(64) }]));
  await assert.rejects(core.accept(pages, [{ ...head, siteOrigin: 'https://other.example' }]));
  await assert.rejects(core.accept([...pages, ...pages], [head]));
  await assert.rejects(core.accept(pages, [head, head]));
  assert.deepEqual(f.rows, before);
  f.control.beforeCommit = () => {
    f.control.beforeCommit = undefined;
    f.put('catalogSeoControl', catalogSeoControlId(site), {
      ...idleCatalogSeoControl(site, now),
      writes: 1,
    });
  };
  await assert.rejects(core.accept(pages, [head]), CatalogSeoDeliveryChangedError);
  assert.equal(f.rows.has(`catalogSeoPages/${id}`), false);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.state, 'pending');
});

test('stateless retry clears only this run and each mutation stays in one bounded transaction', async (t) => {
  const f = articleSdkFixture(t);
  const db: unknown = f.db;
  native(db);
  const id = seed(f);
  const store = createCatalogSeoStore(db);
  const core = createCatalogSeoDeliveryStateless(store, site, 0, 'run', () => now);
  const { ticket } = await core.begin(['p']);
  await core.end(ticket, 'verified');
  const before = structuredClone(f.rows.get(`catalogSeoTasks/${id}`));
  await createCatalogSeoDeliveryStateless(store, site, 0, 'other', () => now).retryKnownFailure([
    'p',
  ]);
  assert.deepEqual(f.rows.get(`catalogSeoTasks/${id}`), before);
  const calls = f.calls.length;
  const ids = Array.from({ length: 13 }, (_, index) => `p-${index}`);
  await assert.rejects(core.begin(ids));
  await assert.rejects(core.retryKnownFailure(ids));
  await assert.rejects(
    core.accept(
      ids.map((productId) => ({ productId, htmlSha256: null })),
      [],
    ),
  );
  assert.equal(f.calls.length, calls);
  await createCatalogSeoDeliveryStateless(store, site, 0, 'run', () => now).retryKnownFailure([
    'p',
  ]);
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.state, 'pending');
  assert.equal(f.rows.get(`catalogSeoTasks/${id}`)?.lease, null);
  assert.equal(f.calls.filter((call) => call.api === 'database.startTransaction').length, 4);
});
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
