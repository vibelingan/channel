import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { recordCatalogSeoWrites } from './catalog-seo-write.ts';

const config = { siteOrigin: 'https://shop.example', detailEnabled: true };
const before = { _id: 'p', name: 'Headset', published: true };

function database() {
  let rows = new Map<string, CollectionDoc>([['products/p', before]]);
  const run = async (failRequests: boolean) => {
    const copy = structuredClone(rows);
    let writing = false;
    await recordCatalogSeoWrites(
      {
        get: async (collection, id) => {
          assert.equal(writing, false, 'all reads must precede the first native write');
          return copy.get(`${collection}/${id}`) ?? null;
        },
        set: async (collection, row) => {
          writing = true;
          if (failRequests && collection === 'catalogSeoRequests')
            throw new Error('request write failed');
          copy.set(`${collection}/${row._id}`, structuredClone(row));
        },
      },
      config,
      async (tx) => {
        const p = await tx.get('products', 'p');
        assert.ok(p);
        await tx.set('products', { ...p, name: 'New headset' });
      },
    );
    rows = copy;
  };
  return { run, rows: () => [...rows.entries()] };
}

test('actual transaction work and its request commit together', async () => {
  const db = database();
  await db.run(false);
  assert.equal(db.rows().find(([key]) => key === 'products/p')?.[1].name, 'New headset');
  const request = db.rows().filter(([key]) => key.startsWith('catalogSeoRequests/'));
  assert.equal(request.length, 1);
  assert.equal(request[0]?.[1].productId, 'p');
});

test('request storage failure aborts the product transaction', async () => {
  const db = database();
  await assert.rejects(db.run(true), /request write failed/);
  assert.deepEqual(db.rows(), [['products/p', before]]);
});

test('disabled recording preserves class methods and their receiver', async () => {
  class Store {
    row = before;
    async get() {
      return this.row;
    }
    async set(_collection: string, row: typeof before) {
      this.row = row;
    }
  }
  const base = new Store();
  await recordCatalogSeoWrites(base, undefined, async (tx) => {
    assert.equal((await tx.get('products', 'p'))?.name, 'Headset');
    await tx.set('products', { ...before, name: 'Changed' });
  });
  assert.equal(base.row.name, 'Changed');
});

test('invalid reserved operation budgets fail before calling the business operation', async () => {
  for (const externalOperations of [-1, 0.5, Number.NaN, 101]) {
    let called = false;
    await assert.rejects(
      recordCatalogSeoWrites(
        {
          get: async (collection: string) => (collection === 'products' ? before : null),
          set: async () => {},
        },
        config,
        async () => {
          called = true;
        },
        { externalOperations },
      ),
    );
    assert.equal(called, false);
  }
});

test('a business exception flushes no writes and read-after-write remains rejected', async () => {
  const writes: CollectionDoc[] = [];
  const base = {
    get: async (collection: string) => (collection === 'products' ? before : null),
    set: async (_: string, row: CollectionDoc) => {
      writes.push(row);
    },
  };
  await assert.rejects(
    recordCatalogSeoWrites(base, config, async (tx) => {
      await tx.set('products', { ...before, name: 'Changed' });
      throw new Error('business failure');
    }),
    /business failure/,
  );
  assert.deepEqual(writes, []);
  await assert.rejects(
    recordCatalogSeoWrites(base, config, async (tx) => {
      await tx.set('products', before);
      await tx.get('products', 'p');
    }),
    /Read after/,
  );
  assert.deepEqual(writes, []);
});

test('a transaction ending at its original public content produces no request', async () => {
  const writes: Array<{ collection: string; row: CollectionDoc }> = [];
  await recordCatalogSeoWrites(
    {
      get: async (collection: string) => (collection === 'products' ? before : null),
      set: async (collection, row) => {
        writes.push({ collection, row });
      },
    },
    config,
    async (tx) => {
      await tx.set('products', { ...before, name: 'Intermediate' });
      await tx.set('products', before);
    },
  );
  assert.equal(writes.length, 2);
  assert.equal(
    writes.some((w) => w.collection === 'catalogSeoRequests'),
    false,
  );
});

test('buffered data is isolated from later caller mutation and delivery leases remain untouched', async () => {
  const writes: Array<{ collection: string; row: CollectionDoc }> = [];
  await recordCatalogSeoWrites(
    {
      get: async (collection: string) => (collection === 'products' ? before : null),
      set: async (collection, row) => {
        writes.push({ collection, row });
      },
    },
    config,
    async (tx) => {
      const changed = { ...before, name: 'Changed' };
      await tx.set('products', changed);
      changed.name = 'Uncommitted later mutation';
    },
  );
  assert.equal(writes.find((write) => write.collection === 'products')?.row.name, 'Changed');
  assert.deepEqual(
    writes.map((w) => w.collection),
    ['catalogSeoControl', 'products', 'catalogSeoRequests'],
  );
});

test('the native 100-operation boundary includes the request and preserves existing large approval capacity', async () => {
  for (const count of [96, 97]) {
    const writes: string[] = [];
    const run = recordCatalogSeoWrites(
      {
        get: async (collection: string) => (collection === 'products' ? before : null),
        set: async (collection) => {
          writes.push(collection);
        },
      },
      config,
      async (tx) => {
        await tx.set('products', { ...before, name: 'Changed' });
        for (let index = 1; index < count; index++)
          await tx.set('approvalRows', { _id: `row-${index}` });
      },
    );
    if (count === 96) {
      await run;
      assert.equal(writes.length, 98);
      assert.equal(writes.at(-1), 'catalogSeoRequests');
    } else {
      await assert.rejects(run, /operation budget/);
      assert.deepEqual(writes, []);
    }
  }
});
