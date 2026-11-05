import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type CatalogPublicChangeStore,
  type CatalogPublicState,
  planCatalogPublicChange,
  writeCatalogPublicChange,
} from './catalog-public-changes.ts';

const siteOrigin = 'https://shop.example';
const productId = 'product-1';
const now = '2026-10-29T01:00:00.000Z';
const absent = { productId, visible: false } as const;
const publicA = {
  productId,
  visible: true,
  semanticHash: 'a'.repeat(64),
  detailRevision: 'approval-a',
} as const;

/** Copy-on-write transaction: a thrown write never publishes its staged changes. */
class Database {
  rows = new Map<string, CollectionDoc>();
  failCollection: string | null = null;

  async transaction<T>(run: (tx: CatalogPublicChangeStore) => Promise<T>): Promise<T> {
    const staged = structuredClone(this.rows);
    let writing = false;
    const tx: CatalogPublicChangeStore = {
      get: async (collection, id) => {
        assert.equal(writing, false, 'a transaction must finish all reads before writes');
        return structuredClone(staged.get(`${collection}/${id}`) ?? null);
      },
      set: async (collection, row) => {
        writing = true;
        if (collection === this.failCollection) throw new Error('injected storage failure');
        staged.set(`${collection}/${row._id}`, structuredClone(row));
      },
    };
    const result = await run(tx);
    this.rows = staged;
    return result;
  }

  collection(name: string) {
    return [...this.rows].filter(([key]) => key.startsWith(`${name}/`)).map(([, row]) => row);
  }
}

async function change(
  db: Database,
  before: CatalogPublicState,
  after: CatalogPublicState,
  options: { siteOrigin?: string; now?: string } = {},
) {
  return db.transaction(async (tx) => {
    const plan = await planCatalogPublicChange(tx, {
      siteOrigin,
      before,
      after,
      now,
      ...options,
    });
    await tx.set('products', { _id: productId, published: after.visible });
    await writeCatalogPublicChange(tx, plan);
    return plan;
  });
}

test('publishing a product commits its public version and one pending refresh with the product', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  assert.equal(db.rows.get(`products/${productId}`)?.published, true);
  const heads = db.collection('catalogPublicHeads');
  const tasks = db.collection('catalogSeoTasks');
  assert.equal(heads.length, 1);
  assert.equal(tasks.length, 1);
  assert.equal(heads[0]?.productId, productId);
  assert.equal(heads[0]?.siteOrigin, siteOrigin);
  assert.equal(heads[0]?.sequence, 1);
  assert.equal(heads[0]?.semanticHash, publicA.semanticHash);
  assert.equal(heads[0]?.changedAt, now);
  assert.equal(tasks[0]?.requestedSequence, 1);
  assert.equal(tasks[0]?.acceptedSequence, 0);
  assert.equal(tasks[0]?.state, 'pending');
  assert.equal(tasks[0]?.lease, null);
});

test('a failed refresh-record write rolls back the product and public version', async () => {
  const db = new Database();
  db.rows.set(`products/${productId}`, { _id: productId, published: false });
  const before = structuredClone(db.rows);
  db.failCollection = 'catalogSeoTasks';
  await assert.rejects(change(db, absent, publicA), /injected storage failure/);
  assert.deepEqual(db.rows, before);
});

test('saving a private product does not create a public version or refresh task', async () => {
  const db = new Database();
  await change(db, absent, absent);
  assert.deepEqual(db.collection('catalogPublicHeads'), []);
  assert.deepEqual(db.collection('catalogSeoTasks'), []);
});

function only(db: Database, collection: string) {
  const rows = db.collection(collection);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  return row;
}

function patch(db: Database, collection: string, values: Record<string, unknown>) {
  const row = only(db, collection);
  db.rows.set(`${collection}/${row._id}`, { ...row, ...values });
}

const publicB = { ...publicA, semanticHash: 'b'.repeat(64), detailRevision: 'approval-b' };

test('a retry using the current public content neither increments its version nor wakes work', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  const before = structuredClone(db.rows);
  await change(db, publicA, publicA, { now: '2026-10-29T02:00:00.000Z' });
  assert.deepEqual(db.rows, before);
});

test('an existing public product is not declared delivered just because its content is unchanged', async () => {
  const db = new Database();
  await change(db, publicA, publicA);
  assert.deepEqual(db.collection('catalogPublicHeads'), []);
  assert.deepEqual(db.collection('catalogSeoTasks'), []);
});

test('three content changes coalesce into one latest pending task', async () => {
  const db = new Database();
  const publicC = { ...publicA, semanticHash: 'c'.repeat(64), detailRevision: 'approval-c' };
  await change(db, absent, publicA);
  await change(db, publicA, publicB);
  await change(db, publicB, publicC);
  assert.equal(only(db, 'catalogPublicHeads').sequence, 3);
  assert.equal(only(db, 'catalogPublicHeads').semanticHash, publicC.semanticHash);
  assert.equal(only(db, 'catalogSeoTasks').requestedSequence, 3);
  assert.equal(only(db, 'catalogSeoTasks').acceptedSequence, 0);
});

test('changing content back to an earlier value is a new version rather than a duplicate', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  const firstEvent = only(db, 'catalogPublicHeads').latestEventId;
  await change(db, publicA, publicB);
  await change(db, publicB, publicA);
  const head = only(db, 'catalogPublicHeads');
  assert.equal(head.sequence, 3);
  assert.equal(head.semanticHash, publicA.semanticHash);
  assert.notEqual(head.latestEventId, firstEvent);
});

test('reapproval with identical public content updates its read revision without claiming a content change', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  const headBefore = only(db, 'catalogPublicHeads');
  const taskBefore = only(db, 'catalogSeoTasks');
  const reapproved = { ...publicA, detailRevision: 'approval-new' };
  await change(db, publicA, reapproved, { now: '2026-10-29T02:00:00.000Z' });
  const head = only(db, 'catalogPublicHeads');
  assert.equal(head.detailRevision, 'approval-new');
  assert.equal(head.sequence, 1);
  assert.equal(head.changedAt, headBefore.changedAt);
  assert.equal(head.latestEventId, headBefore.latestEventId);
  assert.deepEqual(only(db, 'catalogSeoTasks'), taskBefore);
});

test('withdrawal retains a tombstone and republication continues the same version history', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  const originalId = only(db, 'catalogPublicHeads')._id;
  await change(db, publicA, absent);
  assert.equal(only(db, 'catalogPublicHeads').visible, false);
  assert.equal(only(db, 'catalogPublicHeads').detailRevision, null);
  assert.equal(only(db, 'catalogPublicHeads').sequence, 2);
  assert.equal(only(db, 'catalogSeoTasks').requestedSequence, 2);
  await change(db, absent, publicA);
  assert.equal(only(db, 'catalogPublicHeads')._id, originalId);
  assert.equal(only(db, 'catalogPublicHeads').sequence, 3);
  assert.equal(only(db, 'catalogPublicHeads').visible, true);
});

for (const state of ['leased', 'writing', 'needs-readback']) {
  test(`new content preserves an existing ${state} owner even after its lease time`, async () => {
    const db = new Database();
    await change(db, absent, publicA);
    const lease = { runId: 'runner-1', sequence: 1, until: '2026-10-28T01:00:00.000Z' };
    patch(db, 'catalogSeoTasks', { state, lease, attempts: 2 });
    await change(db, publicA, publicB);
    const task = only(db, 'catalogSeoTasks');
    assert.equal(task.requestedSequence, 2);
    assert.equal(task.acceptedSequence, 0);
    assert.equal(task.state, state);
    assert.equal(task.attempts, 2);
    assert.deepEqual(task.lease, lease);
  });
}

test('an accepted version stays acknowledged when a newer change becomes pending', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  patch(db, 'catalogSeoTasks', { state: 'accepted', acceptedSequence: 1, attempts: 2 });
  await change(db, publicA, publicB);
  const task = only(db, 'catalogSeoTasks');
  assert.equal(task.requestedSequence, 2);
  assert.equal(task.acceptedSequence, 1);
  assert.equal(task.state, 'pending');
  assert.equal(task.lease, null);
  assert.equal(task.attempts, 0);
});

test('new public content gets a fresh retry budget after an older pending version failed', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  patch(db, 'catalogSeoTasks', { attempts: 3 });
  await change(db, publicA, publicB);
  assert.equal(only(db, 'catalogSeoTasks').attempts, 0);
});

test('identical public content cannot reset the retry budget of a failed pending version', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  patch(db, 'catalogSeoTasks', { attempts: 3 });
  await change(db, publicA, { ...publicA, detailRevision: 'new-read-revision' });
  assert.equal(only(db, 'catalogSeoTasks').attempts, 3);
  assert.equal(only(db, 'catalogSeoTasks').requestedSequence, 1);
});

test('the same product ID in different sites cannot overwrite the other site records', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  const firstHead = only(db, 'catalogPublicHeads');
  await change(db, absent, publicB, { siteOrigin: 'https://other.example' });
  assert.equal(db.collection('catalogPublicHeads').length, 2);
  assert.equal(db.collection('catalogSeoTasks').length, 2);
  assert.deepEqual(db.rows.get(`catalogPublicHeads/${firstHead._id}`), firstHead);
});

for (const broken of ['catalogPublicHeads', 'catalogSeoTasks']) {
  test(`a missing ${broken} partner is rejected rather than resetting the version`, async () => {
    const db = new Database();
    await change(db, absent, publicA);
    const row = only(db, broken);
    db.rows.delete(`${broken}/${row._id}`);
    const before = structuredClone(db.rows);
    await assert.rejects(change(db, publicA, publicB), { code: 'CORRUPT_RECORD' });
    assert.deepEqual(db.rows, before);
  });
}

test('a stale public before-state cannot overwrite the current head', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  const before = structuredClone(db.rows);
  await assert.rejects(change(db, publicB, publicA), { code: 'PUBLIC_HEAD_MISMATCH' });
  assert.deepEqual(db.rows, before);
});

test('a task claiming a different requested version fails closed', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  patch(db, 'catalogSeoTasks', { requestedSequence: 2 });
  await assert.rejects(change(db, publicA, publicB), { code: 'CORRUPT_RECORD' });
});

test('safe integer exhaustion stops the change instead of losing version precision', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  patch(db, 'catalogPublicHeads', { sequence: Number.MAX_SAFE_INTEGER });
  patch(db, 'catalogSeoTasks', { requestedSequence: Number.MAX_SAFE_INTEGER });
  const before = structuredClone(db.rows);
  await assert.rejects(change(db, publicA, publicB), { code: 'PUBLIC_SEQUENCE_EXHAUSTED' });
  assert.deepEqual(db.rows, before);
});

test('a backwards clock cannot fabricate a new last-modified time', async () => {
  const db = new Database();
  await change(db, absent, publicA);
  await assert.rejects(change(db, publicA, publicB, { now: '2026-10-28T01:00:00.000Z' }), {
    code: 'PUBLIC_CLOCK_REGRESSION',
  });
});

test('a prepared change cannot be applied inside a different transaction', async () => {
  const db = new Database();
  const plan = await db.transaction((tx) =>
    planCatalogPublicChange(tx, { siteOrigin, before: absent, after: publicA, now }),
  );
  await assert.rejects(
    db.transaction((tx) => writeCatalogPublicChange(tx, plan)),
    {
      code: 'INVALID_PLAN',
    },
  );
  assert.equal(db.rows.size, 0);
});

test('a write attempt is not blindly repeated when its result failed', async () => {
  const db = new Database();
  await db.transaction(async (tx) => {
    const plan = await planCatalogPublicChange(tx, {
      siteOrigin,
      before: absent,
      after: publicA,
      now,
    });
    db.failCollection = 'catalogPublicHeads';
    await assert.rejects(writeCatalogPublicChange(tx, plan), /injected storage failure/);
    db.failCollection = null;
    await assert.rejects(writeCatalogPublicChange(tx, plan), { code: 'INVALID_PLAN' });
  });
  assert.equal(db.rows.size, 0);
});

test('caller mutations after planning cannot change the content committed', async () => {
  const db = new Database();
  const after = { ...publicA };
  await db.transaction(async (tx) => {
    const plan = await planCatalogPublicChange(tx, { siteOrigin, before: absent, after, now });
    after.semanticHash = publicB.semanticHash;
    await writeCatalogPublicChange(tx, plan);
  });
  assert.equal(only(db, 'catalogPublicHeads').semanticHash, publicA.semanticHash);
});

for (const invalid of [
  { siteOrigin: 'http://shop.example' },
  { siteOrigin: 'https://user:password@shop.example' },
  { siteOrigin: 'https://shop.example/path' },
  { before: { productId: 'other-product', visible: false } },
  { after: { ...publicA, semanticHash: 'not-a-content-digest' } },
  { after: { ...publicA, detailRevision: ' approval-a ' } },
  { after: { ...publicA, productId: 'product\u0000hidden' } },
  { after: { ...absent, semanticHash: publicA.semanticHash } },
  { now: '2026-02-30T01:00:00.000Z' },
]) {
  test(`malformed public-change input is rejected before storage: ${JSON.stringify(invalid)}`, async () => {
    const db = new Database();
    await assert.rejects(
      db.transaction(async (tx) => {
        const plan = await planCatalogPublicChange(tx, {
          siteOrigin,
          before: absent,
          after: publicA,
          now,
          ...invalid,
        });
        await writeCatalogPublicChange(tx, plan);
      }),
      { code: 'INVALID_INPUT' },
    );
    assert.equal(db.rows.size, 0);
  });
}

for (const [collection, invalid] of [
  ['catalogPublicHeads', { sequence: '1' }],
  ['catalogPublicHeads', { sequence: 1.5 }],
  ['catalogPublicHeads', { schemaVersion: 2 }],
  ['catalogPublicHeads', { siteOrigin: 'https://other.example' }],
  ['catalogPublicHeads', { visible: false }],
  ['catalogSeoTasks', { acceptedSequence: -1 }],
  ['catalogSeoTasks', { acceptedSequence: 2 }],
  ['catalogSeoTasks', { state: 'writing', lease: null }],
  ['catalogSeoTasks', { state: 'accepted', acceptedSequence: 0 }],
  [
    'catalogSeoTasks',
    { state: 'leased', attempts: 1, lease: { runId: 'other', sequence: 2, until: now } },
  ],
] as const) {
  test(`corrupt public records cannot be overwritten: ${collection}${JSON.stringify(invalid)}`, async () => {
    const db = new Database();
    await change(db, absent, publicA);
    patch(db, collection, invalid);
    const before = structuredClone(db.rows);
    await assert.rejects(change(db, publicA, publicB), { code: 'CORRUPT_RECORD' });
    assert.deepEqual(db.rows, before);
  });
}

test('fabricating a serialized plan cannot bypass the transaction that prepared it', async () => {
  const db = new Database();
  await assert.rejects(
    db.transaction((tx) =>
      writeCatalogPublicChange(tx, { kind: 'changed', productId, siteOrigin, sequence: 1 }),
    ),
    { code: 'INVALID_PLAN' },
  );
  assert.equal(db.rows.size, 0);
});
