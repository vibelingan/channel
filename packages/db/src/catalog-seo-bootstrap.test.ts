import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { catalogPublicRecordId } from './catalog-public-changes.ts';
import { seedCatalogSeoRequests } from './catalog-seo-bootstrap.ts';
import { type CatalogSeoDatabase, createCatalogSeoStore } from './catalog-seo-cloud.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';
const config = { siteOrigin: 'https://fixture.example', detailEnabled: true };
const now = '2026-10-30T00:00:00.000Z';

function timedFixture() {
  const rows = new Map<string, CollectionDoc>();
  const durations: number[] = [];
  let active = 0;
  let peak = 0;
  const store: CatalogSeoStore = {
    get: async () => {
      throw Error('Bootstrap must read inside its transaction');
    },
    list: async () => {
      throw Error('Bootstrap must not scan business collections');
    },
    transaction: async (operation) => {
      let elapsed = 0;
      active++;
      peak = Math.max(peak, active);
      const writes = new Map<string, CollectionDoc>();
      const roundTrip = async () => {
        elapsed += 1000;
        await Promise.resolve();
        if (elapsed > 30000) throw Error('ResourceUnavailable.TransactionNotExist');
      };
      try {
        await roundTrip();
        const value = await operation({
          get: async (collection, id) => {
            assert.equal(writes.size, 0, 'reads must precede writes');
            await roundTrip();
            return rows.get(`${collection}/${id}`) ?? null;
          },
          set: async (collection, row) => {
            assert.equal(collection, 'catalogSeoRequests');
            await roundTrip();
            writes.set(`${collection}/${row._id}`, structuredClone(row));
          },
        });
        await roundTrip();
        for (const [key, row] of writes) rows.set(key, row);
        durations.push(elapsed);
        return value;
      } finally {
        active--;
      }
    },
  };
  return { store, rows, durations, peak: () => peak, active: () => active };
}

// CloudBase caps a transaction at 30 seconds, including network round trips:
// https://docs.cloudbase.net/database/transaction
test('a slow 528-product bootstrap stays below the transaction lifetime with bounded parallel work', async () => {
  const x = timedFixture();
  const ids = Array.from({ length: 528 }, (_, i) => `slow-${i}`);
  const result = await seedCatalogSeoRequests(x.store, config, ids, now);
  assert.deepEqual(result, { queued: 528, preserved: 0, tracked: 0, upgraded: 0 });
  assert.equal(x.rows.size, 528);
  assert.equal(x.durations.length, 528);
  assert.ok(x.durations.every((duration) => duration <= 5000));
  assert.ok(x.peak() > 1 && x.peak() <= 4);
  assert.equal(x.active(), 0);
});

function fixture() {
  const rows = new Map<string, CollectionDoc>();
  const sizes: number[] = [];
  const store: CatalogSeoStore = {
    get: async (c, id) => rows.get(`${c}/${id}`) ?? null,
    list: async () => [],
    transaction: async (fn) => {
      let written = false;
      let n = 0;
      const result = await fn({
        get: async (c, id) => {
          assert.equal(written, false, 'all reads precede transaction writes');
          n++;
          return rows.get(`${c}/${id}`) ?? null;
        },
        set: async (c, row) => {
          assert.equal(c, 'catalogSeoRequests');
          written = true;
          n++;
          rows.set(`${c}/${row._id}`, structuredClone(row));
        },
      });
      sizes.push(n);
      return result;
    },
  };
  return { rows, sizes, store };
}
test('existing URLs are seeded in bounded transactions without business writes or duplicate IDs', async () => {
  const x = fixture();
  const ids = Array.from({ length: 137 }, (_, i) => `product-${i}`);
  const first = await seedCatalogSeoRequests(x.store, config, [...ids, 'product-0'], now);
  assert.equal(first.queued, 137);
  assert.equal(x.sizes.length, 137);
  assert.ok(x.sizes.every((n) => n <= 3));
  const before = structuredClone(x.rows);
  const again = await seedCatalogSeoRequests(x.store, config, ids, now);
  assert.equal(again.preserved, 137);
  assert.deepEqual(x.rows, before);
});
test('an existing head and a newer pending request survive the bootstrap', async () => {
  const x = fixture();
  x.rows.set(`catalogPublicHeads/${catalogPublicRecordId(config.siteOrigin, 'tracked')}`, {
    _id: catalogPublicRecordId(config.siteOrigin, 'tracked'),
  });
  const newer = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'pending', previouslyPublic: true },
    '2026-10-30T01:00:00.000Z',
  );
  x.rows.set(`catalogSeoRequests/${newer._id}`, newer);
  const result = await seedCatalogSeoRequests(x.store, config, ['tracked', 'pending'], now);
  assert.equal(result.tracked, 1);
  assert.equal(result.preserved, 1);
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${newer._id}`), newer);
});
test('a withdrawn accepted URL keeps its pending token and gains only the known-public flag', async () => {
  const x = fixture();
  const previous = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'withdrawn', previouslyPublic: false },
    now,
  );
  x.rows.set(`catalogSeoRequests/${previous._id}`, previous);
  const result = await seedCatalogSeoRequests(x.store, config, ['withdrawn'], now);
  assert.equal(result.upgraded, 1);
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${previous._id}`), {
    ...previous,
    previouslyPublic: true,
  });
});

test('a failed batch finishes its other transactions before rejecting and starts no further products', async () => {
  const x = fixture();
  const products = ['held', 'failed', 'third', 'fourth', 'must-not-start'];
  const started: string[] = [];
  const failure = Error('Synthetic transaction failure');
  let completed = 0;
  let settled = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: CatalogSeoStore = {
    ...x.store,
    transaction: async (operation) => {
      try {
        return await x.store.transaction((tx) =>
          operation({
            ...tx,
            get: async (collection, id) => {
              if (collection === 'catalogPublicHeads') {
                started.push(id);
                if (id === catalogPublicRecordId(config.siteOrigin, 'failed')) throw failure;
                if (id === catalogPublicRecordId(config.siteOrigin, 'held')) await held;
              }
              return tx.get(collection, id);
            },
          }),
        );
      } finally {
        completed++;
      }
    },
  };
  const result = seedCatalogSeoRequests(store, config, products, now).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await nextTurn();
    assert.equal(started.length, 4);
    assert.equal(completed, 3);
    assert.equal(settled, false);
  } finally {
    release();
  }
  assert.equal(await result, failure);
  assert.equal(completed, 4);
  assert.equal(x.rows.size, 3);
  assert.equal(started.includes(catalogPublicRecordId(config.siteOrigin, 'must-not-start')), false);
});

function catalogDatabase(value: unknown): asserts value is CatalogSeoDatabase {
  assert.ok(value && typeof value === 'object');
  assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
  assert.equal(typeof Reflect.get(value, 'collection'), 'function');
  const command = Reflect.get(value, 'command');
  assert.ok(command && typeof command === 'object');
  assert.equal(typeof Reflect.get(command, 'gt'), 'function');
}

test('the installed SDK retries a conflicting newer request without losing its token or double-counting', async (t) => {
  const x = articleSdkFixture(t);
  catalogDatabase(x.db);
  const previous = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'racing-request', previouslyPublic: false },
    now,
  );
  const newer = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'racing-request', previouslyPublic: false },
    '2026-10-30T02:00:00.000Z',
  );
  x.put('catalogSeoRequests', previous._id, previous);
  x.control.beforeCommit = () => {
    x.control.beforeCommit = undefined;
    x.put('catalogSeoRequests', newer._id, newer);
  };
  const result = await seedCatalogSeoRequests(
    createCatalogSeoStore(x.db),
    config,
    ['racing-request'],
    now,
  );
  assert.deepEqual(result, { queued: 0, preserved: 0, tracked: 0, upgraded: 1 });
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${newer._id}`), {
    ...newer,
    previouslyPublic: true,
  });
  assert.equal(x.calls.filter((call) => call.api === 'database.startTransaction').length, 2);
  const writes = x.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.equal(writes.length, 2);
  assert.ok(writes.every((call) => call.params.collectionName === 'catalogSeoRequests'));
});

test('the installed SDK preserves a head created during commit and does not replace its pending request', async (t) => {
  const x = articleSdkFixture(t);
  catalogDatabase(x.db);
  const request = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'racing-head', previouslyPublic: false },
    now,
  );
  const headId = catalogPublicRecordId(config.siteOrigin, 'racing-head');
  const head = { _id: headId, fixtureRevision: 2 };
  x.put('catalogSeoRequests', request._id, request);
  x.control.beforeCommit = () => {
    x.control.beforeCommit = undefined;
    x.put('catalogPublicHeads', headId, head);
  };
  const result = await seedCatalogSeoRequests(
    createCatalogSeoStore(x.db),
    config,
    ['racing-head'],
    now,
  );
  assert.deepEqual(result, { queued: 0, preserved: 0, tracked: 1, upgraded: 0 });
  assert.deepEqual(x.rows.get(`catalogPublicHeads/${headId}`), head);
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${request._id}`), request);
  assert.equal(x.calls.filter((call) => call.api === 'database.startTransaction').length, 2);
});

test('checked requests without a head are requeued and empty or invalid input does not start a transaction', async () => {
  const x = fixture();
  const checked = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'checked', previouslyPublic: false },
    now,
  );
  x.rows.set(`catalogSeoRequests/${checked._id}`, { ...checked, state: 'checked' });
  const result = await seedCatalogSeoRequests(x.store, config, ['checked'], now);
  assert.deepEqual(result, { queued: 1, preserved: 0, tracked: 0, upgraded: 0 });
  const current = x.rows.get(`catalogSeoRequests/${checked._id}`);
  assert.equal(current?.state, 'pending');
  assert.equal(current?.previouslyPublic, true);
  const transactions = x.sizes.length;
  assert.deepEqual(await seedCatalogSeoRequests(x.store, config, [], now), {
    queued: 0,
    preserved: 0,
    tracked: 0,
    upgraded: 0,
  });
  await assert.rejects(seedCatalogSeoRequests(x.store, config, ['valid', ''], now));
  await assert.rejects(seedCatalogSeoRequests(x.store, config, Array(50001).fill('x'), now));
  assert.equal(x.sizes.length, transactions);
});
