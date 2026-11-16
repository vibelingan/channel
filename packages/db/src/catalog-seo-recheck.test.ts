import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { catalogPublicRecordId } from './catalog-public-changes.ts';
import { type CatalogSeoDatabase, createCatalogSeoStore } from './catalog-seo-cloud.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import { recheckCatalogSeoRequests } from './catalog-seo-recheck.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';

const config = { siteOrigin: 'https://fixture.example', detailEnabled: true };
const now = '2026-11-16T00:00:00.000Z';
const idle = async () => {};
const request = (productId: string, previouslyPublic = true) =>
  createCatalogSeoRequest(config.siteOrigin, { kind: 'product', productId, previouslyPublic }, now);

function fixture() {
  const rows = new Map<string, CollectionDoc>();
  const writes: string[] = [];
  let transactions = 0;
  let active = 0;
  let peak = 0;
  const store: CatalogSeoStore = {
    get: async () => {
      throw Error('Recheck must read inside a transaction');
    },
    list: async () => {
      throw Error('Recheck must not scan business collections');
    },
    transaction: async (fn) => {
      transactions++;
      active++;
      peak = Math.max(peak, active);
      const pending = new Map<string, CollectionDoc>();
      try {
        const value = await fn({
          get: async (collection, id) => {
            assert.equal(pending.size, 0, 'all reads precede writes');
            return rows.get(`${collection}/${id}`) ?? null;
          },
          set: async (collection, row) => {
            assert.equal(collection, 'catalogSeoRequests', 'only request rows may change');
            pending.set(`${collection}/${row._id}`, structuredClone(row));
          },
        });
        for (const [key, row] of pending) {
          writes.push(key);
          rows.set(key, row);
        }
        return value;
      } finally {
        active--;
      }
    },
  };
  return {
    rows,
    writes,
    store,
    transactions: () => transactions,
    active: () => active,
    peak: () => peak,
  };
}

test('an existing public head is rechecked without changing business rows or duplicating IDs', async () => {
  const x = fixture();
  const headId = catalogPublicRecordId(config.siteOrigin, 'tracked');
  x.rows.set(`catalogPublicHeads/${headId}`, { _id: headId, revision: 'old' });
  x.rows.set('products/tracked', { _id: 'tracked', name: 'Current product' });
  x.rows.set('catalogSeoTasks/task', { _id: 'task', state: 'accepted' });
  const before = structuredClone(x.rows);
  const result = await recheckCatalogSeoRequests(
    x.store,
    config,
    ['tracked', 'tracked'],
    now,
    idle,
  );
  assert.deepEqual(result, { queued: 1, preserved: 0, upgraded: 0 });
  assert.equal(x.transactions(), 1);
  assert.equal(x.writes.length, 1);
  const queued = x.rows.get(`catalogSeoRequests/${request('tracked')._id}`);
  assert.equal(queued?.state, 'pending');
  assert.equal(queued?.previouslyPublic, true);
  for (const [key, row] of before) assert.deepEqual(x.rows.get(key), row);
});

test('pending requests keep their token and body; only previouslyPublic may become true', async () => {
  const x = fixture();
  const kept = request('kept');
  const upgraded = request('upgraded', false);
  x.rows.set(`catalogSeoRequests/${kept._id}`, kept);
  x.rows.set(`catalogSeoRequests/${upgraded._id}`, upgraded);
  assert.deepEqual(
    await recheckCatalogSeoRequests(x.store, config, ['kept', 'upgraded'], now, idle),
    { queued: 0, preserved: 1, upgraded: 1 },
  );
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${kept._id}`), kept);
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${upgraded._id}`), {
    ...upgraded,
    previouslyPublic: true,
  });
  assert.deepEqual(x.writes, [`catalogSeoRequests/${upgraded._id}`]);
});

test('checked requests receive a fresh pending token', async () => {
  const x = fixture();
  const checked = { ...request('checked'), state: 'checked' };
  x.rows.set(`catalogSeoRequests/${checked._id}`, checked);
  assert.deepEqual(await recheckCatalogSeoRequests(x.store, config, ['checked'], now, idle), {
    queued: 1,
    preserved: 0,
    upgraded: 0,
  });
  const queued = x.rows.get(`catalogSeoRequests/${checked._id}`);
  assert.equal(queued?.state, 'pending');
  assert.notEqual(queued?.token, checked.token);
  assert.equal(queued?.previouslyPublic, true);
});

test('a request belonging to another site or product is rejected without replacing it', async () => {
  for (const change of [
    { siteOrigin: 'https://other.example' },
    { productId: 'other-product' },
    { _id: 'a'.repeat(64) },
  ]) {
    const x = fixture();
    const original = request('scoped');
    const row = { ...original, ...change };
    x.rows.set(`catalogSeoRequests/${original._id}`, row);
    await assert.rejects(recheckCatalogSeoRequests(x.store, config, ['scoped'], now, idle));
    assert.deepEqual(x.rows.get(`catalogSeoRequests/${original._id}`), row);
    assert.equal(x.writes.length, 0);
  }
});

test('each transaction checks the publication fence before reading or writing a request', async () => {
  const x = fixture();
  const ids = Array.from({ length: 13 }, (_, i) => `product-${i}`);
  let guards = 0;
  const guard = async (tx: Parameters<Parameters<CatalogSeoStore['transaction']>[0]>[0]) => {
    guards++;
    assert.equal(await tx.get('siteReleaseTargets', 'website'), null);
    assert.equal(await tx.get('siteReleaseScopes', 'catalog'), null);
  };
  const result = await recheckCatalogSeoRequests(x.store, config, ids, now, guard);
  assert.equal(result.queued, 13);
  assert.equal(guards, 13);
  assert.ok(x.peak() > 1 && x.peak() <= 4);
  assert.equal(x.active(), 0);
  const before = structuredClone(x.rows);
  const failure = Error('Website no longer idle');
  await assert.rejects(
    recheckCatalogSeoRequests(x.store, config, ['blocked'], now, async () => {
      throw failure;
    }),
    (error: unknown) => error instanceof AggregateError && error.errors[0]?.cause === failure,
  );
  assert.deepEqual(x.rows, before);
});

test('a failed batch drains all in-flight work, reports every failure and leaves queued rows intact', async () => {
  const x = fixture();
  const failures = [Error('first failure'), Error('second failure')];
  const ids = ['held', 'failed-a', 'failed-b', 'ok', 'must-not-start'];
  const started: string[] = [];
  let completed = 0;
  let settled = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: CatalogSeoStore = {
    ...x.store,
    transaction: async (fn) => {
      try {
        return await x.store.transaction((tx) =>
          fn({
            ...tx,
            get: async (collection, id) => {
              if (collection === 'catalogSeoRequests') {
                started.push(id);
                if (id === request('failed-a')._id) throw failures[0];
                if (id === request('failed-b')._id) throw failures[1];
                if (id === request('held')._id) await held;
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
  const result = recheckCatalogSeoRequests(store, config, ids, now, idle).then(
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
  const error = await result;
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(
    error.errors.map((failure) => failure.cause),
    failures,
  );
  assert.match(error.errors[0].message, /failed-a/u);
  assert.match(error.errors[1].message, /failed-b/u);
  assert.equal(completed, 4);
  assert.equal(x.rows.size, 2);
  assert.equal(x.active(), 0);
  assert.equal(started.includes(request('must-not-start')._id), false);
  assert.equal(x.rows.get(`catalogSeoRequests/${request('held')._id}`)?.state, 'pending');
});

test('invalid input starts no transactions and empty input does no work', async () => {
  const x = fixture();
  assert.deepEqual(await recheckCatalogSeoRequests(x.store, config, [], now, idle), {
    queued: 0,
    preserved: 0,
    upgraded: 0,
  });
  await assert.rejects(recheckCatalogSeoRequests(x.store, config, ['valid', ''], now, idle));
  await assert.rejects(
    recheckCatalogSeoRequests(x.store, config, Array(50001).fill('x'), now, idle),
  );
  assert.equal(x.transactions(), 0);
});

function catalogDatabase(value: unknown): asserts value is CatalogSeoDatabase {
  assert.ok(value && typeof value === 'object');
  assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
  assert.equal(typeof Reflect.get(value, 'collection'), 'function');
  const command = Reflect.get(value, 'command');
  assert.ok(command && typeof command === 'object');
  assert.equal(typeof Reflect.get(command, 'gt'), 'function');
}

test('the installed SDK preserves a newer concurrent pending request when it retries', async (t) => {
  const x = articleSdkFixture(t);
  catalogDatabase(x.db);
  const checked = { ...request('racing'), state: 'checked' };
  const newer = request('racing', false);
  x.put('catalogSeoRequests', checked._id, checked);
  x.control.beforeCommit = () => {
    x.control.beforeCommit = undefined;
    x.put('catalogSeoRequests', newer._id, newer);
  };
  let guards = 0;
  const result = await recheckCatalogSeoRequests(
    createCatalogSeoStore(x.db),
    config,
    ['racing'],
    now,
    async (tx) => {
      guards++;
      await tx.get('siteReleaseTargets', 'website');
    },
  );
  assert.deepEqual(result, { queued: 0, preserved: 0, upgraded: 1 });
  assert.equal(guards, 2, 'the fence must run again when the SDK retries');
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${newer._id}`), {
    ...newer,
    previouslyPublic: true,
  });
  assert.equal(x.calls.filter((call) => call.api === 'database.startTransaction').length, 2);
  assert.ok(
    x.calls
      .filter((call) => call.api === 'database.modifyDocument')
      .every((call) => call.params.collectionName === 'catalogSeoRequests'),
  );
});

test('the installed SDK rechecks a changed publication fence before committing queued requests', async (t) => {
  const x = articleSdkFixture(t);
  catalogDatabase(x.db);
  const target = { _id: 'website', state: 'idle', version: 7 };
  x.put('siteReleaseTargets', 'website', target);
  x.control.beforeCommit = () => {
    x.control.beforeCommit = undefined;
    x.put('siteReleaseTargets', 'website', { ...target, state: 'writing', version: 8 });
  };
  await assert.rejects(
    recheckCatalogSeoRequests(createCatalogSeoStore(x.db), config, ['blocked'], now, async (tx) => {
      assert.deepEqual(await tx.get('siteReleaseTargets', 'website'), target);
    }),
  );
  assert.equal(x.rows.has(`catalogSeoRequests/${request('blocked')._id}`), false);
  assert.equal(x.calls.filter((call) => call.api === 'database.startTransaction').length, 2);
});
