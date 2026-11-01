import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { assertCatalogAcceptanceProof } from './release/catalog-proof.mjs';
const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { createCatalogAcceptanceProof, prepareCatalogAcceptance, finishCatalogAcceptance } =
  tsxRequire('./catalog-acceptance.ts', import.meta.url);
const { articleSdkFixture } = tsxRequire(
  '../packages/db/src/article-sdk-fixture.test-helper.ts',
  import.meta.url,
);
const { createCatalogSeoStore } = tsxRequire(
  '../packages/db/src/catalog-seo-cloud.ts',
  import.meta.url,
);
const { catalogPublicRecordId } = tsxRequire(
  '../packages/db/src/catalog-public-changes.ts',
  import.meta.url,
);
const { catalogSeoControlId, idleCatalogSeoControl } = tsxRequire(
  '../packages/db/src/catalog-seo-control.ts',
  import.meta.url,
);
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const sdkRequire = createRequire(dbRequire.resolve('@cloudbase/node-sdk/package.json'));

const siteOrigin = 'https://fixture.example';
const config = { siteOrigin, detailEnabled: true };
const runId = 'site-123-1';
const now = '2026-11-01T00:00:00.000Z';
const acceptedRun = { state: 'SUCCEEDED', runId, accepted: { sourceRunId: runId } };
function fixture(t, count = 1) {
  const f = articleSdkFixture(t);
  // tsx/cjs and the SDK's ESM entry can load distinct Db classes. Bind the same
  // offline transport to the actual instance; never let a test use cloud credentials.
  const originalRequest = f.db.constructor.reqClass;
  const offlineRequest = sdkRequire('@cloudbase/database').Db.reqClass;
  assert.equal(
    offlineRequest.name,
    'Request',
    'The SDK fixture must install its offline transport',
  );
  f.db.constructor.reqClass = offlineRequest;
  t.after(() => {
    f.db.constructor.reqClass = originalRequest;
  });
  const store = createCatalogSeoStore(f.db);
  const heads = [...Array.from({ length: count }, (_, index) => `p${index + 1}`), 'withdrawn'].map(
    (productId) => ({
      _id: catalogPublicRecordId(siteOrigin, productId),
      schemaVersion: 1,
      siteOrigin,
      productId,
      sequence: 2,
      visible: productId !== 'withdrawn',
      semanticHash: 'a'.repeat(64),
      detailRevision: null,
      changedAt: now,
      latestEventId: 'b'.repeat(64),
    }),
  );
  for (const head of heads) {
    f.put('catalogPublicHeads', head._id, head);
    f.put('catalogSeoTasks', head._id, {
      _id: head._id,
      schemaVersion: 1,
      siteOrigin,
      productId: head.productId,
      requestedSequence: 2,
      acceptedSequence: 1,
      state: 'writing',
      attempts: 1,
      lease: { runId, sequence: 2, until: now },
    });
  }
  const controlId = catalogSeoControlId(siteOrigin);
  const control = { ...idleCatalogSeoControl(siteOrigin, now), writes: 7, fence: 3 };
  f.put('catalogSeoControl', controlId, control);
  const snapshot = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'public',
      siteOrigin,
      products: heads
        .filter((head) => head.visible)
        .map((head) => ({
          product: { _id: head.productId, name: 'Public product' },
          publicVersion: { sequence: 2, semanticHash: 'a'.repeat(64), changedAt: now },
        })),
    }),
  );
  const files = new Map(
    heads
      .filter((head) => head.visible)
      .map((head) => [
        `products/p-${head.productId}/index.html`,
        Buffer.from(`<h1>Public product ${head.productId}</h1>`),
      ]),
  );
  const proof = createCatalogAcceptanceProof({ config, capture: { writes: 7, heads }, snapshot });
  const prepare = (patch = {}) =>
    prepareCatalogAcceptance({
      store,
      proof,
      snapshot,
      runId,
      clock: () => now,
      checkpoint: async () => {},
      checkTransaction: async () => {},
      ...patch,
    });
  return { ...f, store, heads, controlId, control, snapshot, files, proof, prepare };
}

test('a sealed catalog proof binds exact snapshot bytes and every head, including withdrawals', (t) => {
  const f = fixture(t);
  assertCatalogAcceptanceProof(f.proof, { siteOrigin, snapshot: f.snapshot });
  const reversed = createCatalogAcceptanceProof({
    config,
    capture: { writes: 7, heads: [...f.heads].reverse() },
    snapshot: f.snapshot,
  });
  assert.deepEqual(reversed, f.proof);
  const changed = createCatalogAcceptanceProof({
    config,
    capture: {
      writes: 7,
      heads: f.heads.map((head) => (head.visible ? head : { ...head, sequence: 3 })),
    },
    snapshot: f.snapshot,
  });
  assert.notEqual(changed.headsSha256, f.proof.headsSha256);
  assert.throws(() =>
    assertCatalogAcceptanceProof(f.proof, { siteOrigin, snapshot: Buffer.from(`${f.snapshot}\n`) }),
  );
  assert.throws(() =>
    assertCatalogAcceptanceProof(
      { ...f.proof, unreviewed: true },
      { siteOrigin, snapshot: f.snapshot },
    ),
  );
});

test('the real installed SDK completes the same original run without touching product or article content', async (t) => {
  const f = fixture(t);
  f.put('products', 'customer-product', { title: 'Keep customer content' });
  f.put('articleDrafts', 'customer-draft', { body: 'Keep this newer draft' });
  const catalog = await f.prepare();
  await finishCatalogAcceptance({ catalog, files: f.files });
  for (const head of f.heads) {
    const task = f.rows.get(`catalogSeoTasks/${head._id}`);
    assert.equal(task.state, 'accepted');
    assert.equal(task.acceptedSequence, 2);
    assert.equal(task.lease, null);
    assert.equal(f.rows.get(`catalogSeoPages/${head._id}`).ready, head.visible);
  }
  assert.equal(f.rows.get('products/customer-product').title, 'Keep customer content');
  assert.equal(f.rows.get('articleDrafts/customer-draft').body, 'Keep this newer draft');
  const before = structuredClone(f.rows.get(`catalogSeoPages/${f.heads[0]._id}`));
  const again = await f.prepare({ clock: () => '2026-11-01T00:01:00.000Z' });
  await finishCatalogAcceptance({ catalog: again, files: f.files });
  assert.deepEqual(f.rows.get(`catalogSeoPages/${f.heads[0]._id}`), before);
});

test('interruption between registration batches can be resumed without accepting a new product version', async (t) => {
  const f = fixture(t);
  const catalog = await f.prepare();
  let checkpoints = 0;
  await assert.rejects(
    finishCatalogAcceptance({
      catalog,
      files: f.files,
      checkpoint: async () => {
        if (++checkpoints === 2) throw Error('interrupted after DB-only preparation');
      },
    }),
    /interrupted/,
  );
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).state, 'idle');
  assert.equal(f.rows.get(`catalogSeoTasks/${f.heads[0]._id}`).acceptedSequence, 1);
  const current = await f.prepare({ acceptedRun });
  await finishCatalogAcceptance({ catalog: current, files: f.files });
  assert.equal(f.rows.get(`catalogSeoTasks/${f.heads[0]._id}`).acceptedSequence, 2);
});

test('an interruption after some pages committed preserves those receipts while finishing the remaining pages', async (t) => {
  const f = fixture(t, 13);
  const catalog = await f.prepare();
  let checkpoints = 0;
  await assert.rejects(
    finishCatalogAcceptance({
      catalog,
      files: f.files,
      checkpoint: async () => {
        if (++checkpoints === 4) throw Error('interrupted after first acceptance batch');
      },
    }),
    /interrupted/,
  );
  const completed = [...f.rows].filter(([key]) => key.startsWith('catalogSeoPages/'));
  assert.equal(completed.length, 12);
  const saved = new Map(completed.map(([key, value]) => [key, structuredClone(value)]));
  const resumed = await f.prepare({ acceptedRun, clock: () => '2026-11-01T00:01:00.000Z' });
  await finishCatalogAcceptance({ catalog: resumed, files: f.files });
  for (const [key, value] of saved) assert.deepEqual(f.rows.get(key), value);
  assert.equal(
    [...f.rows].filter(
      ([key, row]) => key.startsWith('catalogSeoTasks/') && row.state === 'accepted',
    ).length,
    14,
  );
});

test('a process stop after beginning DB-only registration is recoverable only from the accepted original run', async (t) => {
  const f = fixture(t);
  const catalog = await f.prepare();
  catalog.delivery.end = async () => {
    throw Error('registrar stopped before releasing its DB guard');
  };
  await assert.rejects(finishCatalogAcceptance({ catalog, files: f.files }), /registrar stopped/);
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).state, 'writing');
  const resumed = await f.prepare({ acceptedRun });
  await finishCatalogAcceptance({ catalog: resumed, files: f.files });
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).state, 'idle');
});

test('a new request written after preparation still blocks final registration with unconsumed old heads', async (t) => {
  const f = fixture(t);
  const catalog = await f.prepare();
  f.put('catalogSeoRequests', 'new-request', { siteOrigin, state: 'pending' });
  const before = structuredClone(f.rows);
  await assert.rejects(
    finishCatalogAcceptance({ catalog, files: f.files }),
    /New product requests/,
  );
  assert.deepEqual(f.rows, before);
});

test('only the accepted original run can repair its interrupted DB-only registration guard', async (t) => {
  const f = fixture(t);
  f.put('catalogSeoControl', f.controlId, {
    ...f.control,
    state: 'writing',
    owner: `${runId}:owned-ticket`,
    until: now,
    products: ['p1'],
    families: ['headphones'],
    discovery: false,
  });
  await assert.rejects(f.prepare(), /unknown/);
  const catalog = await f.prepare({ acceptedRun });
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).state, 'idle');
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).writes, 7);
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).fence, 4);
  await finishCatalogAcceptance({ catalog, files: f.files });
  assert.equal(f.rows.get(`catalogSeoTasks/${f.heads[0]._id}`).state, 'accepted');
});

test('a failed site checkpoint prevents the actual DB-only control repair', async (t) => {
  const f = fixture(t);
  const control = {
    ...f.control,
    state: 'writing',
    owner: `${runId}:owned-ticket`,
    until: now,
    products: ['p1'],
    families: ['headphones'],
    discovery: false,
  };
  f.put('catalogSeoControl', f.controlId, control);
  await assert.rejects(
    f.prepare({
      acceptedRun,
      checkpoint: async () => {
        throw Error('Site lease expired');
      },
    }),
    /Site lease/,
  );
  assert.deepEqual(f.rows.get(`catalogSeoControl/${f.controlId}`), control);
  await assert.rejects(
    f.prepare({
      acceptedRun,
      checkTransaction: async () => {
        throw Error('Baseline changed inside transaction');
      },
    }),
    /Baseline changed/,
  );
  assert.deepEqual(f.rows.get(`catalogSeoControl/${f.controlId}`), control);
});

test('accepted cleanup leaves another run task lease and its accepted sequence untouched', async (t) => {
  const f = fixture(t);
  const head = f.heads[1];
  const foreign = {
    ...f.rows.get(`catalogSeoTasks/${head._id}`),
    lease: { runId: 'site-999-1', sequence: 2, until: now },
  };
  f.put('catalogSeoTasks', head._id, foreign);
  const prepared = await f.prepare({ acceptedRun });
  assert.deepEqual(f.rows.get(`catalogSeoTasks/${head._id}`), foreign);
  await assert.rejects(
    finishCatalogAcceptance({ catalog: prepared, files: f.files }),
    /Earlier SEO delivery/,
  );
  assert.deepEqual(f.rows.get(`catalogSeoTasks/${head._id}`), foreign);
});

for (const [label, patch] of [
  ['a different owner', { owner: 'site-999-1:foreign' }],
  ['an unknown discovery upload', { discovery: true }],
  ['an unrelated product', { products: ['unrelated'] }],
]) {
  test(`accepted registration cannot unlock ${label}`, async (t) => {
    const f = fixture(t);
    const control = {
      ...f.control,
      state: 'needs-readback',
      owner: `${runId}:owned`,
      until: now,
      products: ['p1'],
      families: ['headphones'],
      discovery: false,
      ...patch,
    };
    f.put('catalogSeoControl', f.controlId, control);
    await assert.rejects(f.prepare({ acceptedRun }), /unknown/i);
    assert.deepEqual(f.rows.get(`catalogSeoControl/${f.controlId}`), control);
  });
}

for (const label of ['write counter', 'public head', 'pending request']) {
  test(`${label} changes reject old HTML after clearing only the accepted run's unfinished metadata`, async (t) => {
    const f = fixture(t);
    if (label === 'write counter')
      f.put('catalogSeoControl', f.controlId, { ...f.control, writes: 8 });
    if (label === 'public head')
      f.put('catalogPublicHeads', f.heads[1]._id, { ...f.heads[1], sequence: 3 });
    if (label === 'pending request')
      f.put('catalogSeoRequests', 'pending', { siteOrigin, state: 'pending' });
    const before = structuredClone(f.rows);
    await assert.rejects(f.prepare({ acceptedRun }), /changed|New product requests/);
    for (const [key, row] of before) {
      if (!key.startsWith('catalogSeoTasks/')) assert.deepEqual(f.rows.get(key), row);
    }
    for (const head of f.heads) {
      const task = f.rows.get(`catalogSeoTasks/${head._id}`);
      assert.equal(task.acceptedSequence, 1);
      assert.equal(task.requestedSequence, 2);
      assert.equal(task.lease, null);
      assert.equal(task.state, 'pending');
      assert.equal(f.rows.has(`catalogSeoPages/${head._id}`), false);
    }
  });
}

test('a change during paginated head read is not accepted as a stable proof', async (t) => {
  const f = fixture(t);
  const originalList = f.store.list;
  let changed = false;
  f.store.list = async (...args) => {
    const rows = await originalList(...args);
    if (args[0] === 'catalogPublicHeads' && !changed) {
      changed = true;
      f.put('catalogSeoControl', f.controlId, { ...f.control, writes: 8 });
    }
    return rows;
  };
  await assert.rejects(f.prepare(), /changed during/);
});

test('withdrawn HTML and missing visible HTML cannot be registered as successful', async (t) => {
  const f = fixture(t);
  for (const files of [
    new Map(),
    new Map([...f.files, ['products/p-withdrawn/index.html', Buffer.from('old')]]),
  ]) {
    await assert.rejects(
      finishCatalogAcceptance({ catalog: await f.prepare(), files }),
      /HTML differs/,
    );
  }
  assert.equal(f.rows.get(`catalogSeoTasks/${f.heads[0]._id}`).acceptedSequence, 1);
});
