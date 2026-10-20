import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeCloudBaseTransactionReads } from './cloudbase-transaction-reads.ts';

test('native transaction fan-out preserves all results without overlapping document reads', async () => {
  let active = 0;
  let maximum = 0;
  const calls: string[] = [];
  const read = serializeCloudBaseTransactionReads(async (collection, id) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      calls.push(`${collection}/${id}`);
      return { _id: id, collection };
    } finally {
      active--;
    }
  });
  const ids = Array.from({ length: 80 }, (_, i) => `proof-${i}`);
  const values = await Promise.all(ids.map((id) => read('catalogDetailApprovals', id)));
  assert.deepEqual(
    values,
    ids.map((id) => ({ _id: id, collection: 'catalogDetailApprovals' })),
  );
  assert.deepEqual(
    calls,
    ids.map((id) => `catalogDetailApprovals/${id}`),
  );
  assert.equal(maximum, 1);
  assert.equal(active, 0);
});

test('a failed native read aborts queued work and retains its original error', async () => {
  const failure = Object.assign(new Error('original database failure'), {
    code: 'DATABASE_TRANSACTION_FAIL',
  });
  const calls: string[] = [];
  const read = serializeCloudBaseTransactionReads(async (_collection, id) => {
    calls.push(id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (id === 'bad') throw failure;
    return id;
  });
  const values = await Promise.allSettled(
    ['good', 'bad', 'must-not-start'].map((id) => read('images', id)),
  );
  assert.deepEqual(values, [
    { status: 'fulfilled', value: 'good' },
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  await assert.rejects(read('images', 'still-aborted'), (error) => error === failure);
  assert.deepEqual(calls, ['good', 'bad']);
});

test('independent transactions remain concurrent and a fresh retry has a fresh queue', async () => {
  let active = 0;
  let maximum = 0;
  const operation = async (_collection: string, id: string) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    if (id === 'bad') throw Error('retry this transaction');
    return id;
  };
  const first = serializeCloudBaseTransactionReads(operation);
  const second = serializeCloudBaseTransactionReads(operation);
  assert.deepEqual(await Promise.all([first('products', 'one'), second('products', 'two')]), [
    'one',
    'two',
  ]);
  assert.equal(maximum, 2);
  await assert.rejects(first('products', 'bad'), /retry this transaction/);
  const retry = serializeCloudBaseTransactionReads(operation);
  assert.equal(await retry('products', 'one'), 'one');
  assert.equal(active, 0);
});

// Catalog-only reuse must remain inside one read-only transaction snapshot.
import { createCatalogTransactionReads } from './cloudbase-transaction-reads.ts';

test('catalog snapshot reads reuse rows and missing documents without sharing returned objects', async () => {
  const calls: string[] = [];
  const row = { _id: 'p', nested: { labels: ['original'] }, absent: undefined, value: Number.NaN };
  const reads = createCatalogTransactionReads(async (collection, id) => {
    calls.push(JSON.stringify([collection, id]));
    return id === 'missing' ? null : structuredClone(row);
  });
  const first = await reads.get('products', 'p');
  assert.ok(first);
  first.nested.labels[0] = 'changed by caller';
  const second = await reads.get('products', 'p');
  assert.deepEqual(second, row);
  assert.ok(second && Object.hasOwn(second, 'absent'));
  second.nested.labels.push('another mutation');
  assert.deepEqual(await reads.get('products', 'p'), row);
  assert.equal(await reads.get('products', 'missing'), null);
  assert.equal(await reads.get('products', 'missing'), null);
  assert.equal(calls.length, 2);
  await reads.get('a/b', 'c');
  await reads.get('a', 'b/c');
  assert.equal(calls.length, 4, 'Collection and ID boundaries cannot collide');
});

test('catalog snapshot fan-out stays serial and a failed read also poisons cached hits', async () => {
  let active = 0;
  let maximum = 0;
  const calls: string[] = [];
  const failure = Error('native transaction aborted');
  const reads = createCatalogTransactionReads(async (_collection, id) => {
    calls.push(id);
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (id === 'bad') throw failure;
      return { _id: id };
    } finally {
      active--;
    }
  });
  await reads.get('products', 'cached');
  const settled = await Promise.allSettled(
    ['one', 'one', 'bad', 'cached', 'two'].map((id) => reads.get('products', id)),
  );
  assert.equal(maximum, 1);
  assert.deepEqual(calls, ['cached', 'one', 'bad']);
  assert.deepEqual(
    settled.map((x) => x.status),
    ['fulfilled', 'fulfilled', 'rejected', 'rejected', 'rejected'],
  );
  for (const result of settled.slice(2)) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, failure);
  }
  await assert.rejects(reads.get('products', 'cached'), (error) => error === failure);
});

test('the first attempted catalog write permanently disables snapshot reuse, including a refused write', async () => {
  let revision = 1;
  let calls = 0;
  const reads = createCatalogTransactionReads(async (_collection, id) => ({
    _id: id,
    revision: revision++,
    call: ++calls,
  }));
  const before = await reads.get('products', 'p');
  assert.deepEqual(await reads.get('products', 'p'), before);
  // The bridge calls this before awaiting a lease guard or the actual SDK write.
  reads.beforeWrite();
  assert.equal((await reads.get('products', 'p')).revision, 2);
  assert.equal((await reads.get('products', 'p')).revision, 3);
  reads.beforeWrite();
  assert.equal((await reads.get('products', 'p')).revision, 4);
  assert.equal(calls, 4);
});

test('an in-flight read cannot refill catalog cache after the write barrier', async () => {
  let complete: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const reads = createCatalogTransactionReads(async (_collection, id) => {
    calls++;
    if (calls === 1) await gate;
    return { _id: id, calls };
  });
  const first = reads.get('products', 'p');
  await new Promise<void>((resolve) => setImmediate(resolve));
  reads.beforeWrite();
  assert.ok(complete);
  complete();
  await first;
  assert.equal((await reads.get('products', 'p')).calls, 2);
  assert.equal((await reads.get('products', 'p')).calls, 3);
});

test('catalog cache skips SDK-specific objects and oversized rows without changing their values', async () => {
  class Special {
    constructor(readonly value: string) {}
  }
  const rows = [
    { _id: 'date', value: new Date('2026-10-20T00:00:00Z') },
    { _id: 'special', value: new Special('sdk') },
    { _id: 'large', value: 'x'.repeat(512 * 1024) },
  ];
  let calls = 0;
  const reads = createCatalogTransactionReads(async (_collection, id) => {
    calls++;
    return rows.find((row) => row._id === id);
  });
  for (const row of rows) {
    assert.equal(await reads.get('images', row._id), row);
    assert.equal(await reads.get('images', row._id), row);
  }
  assert.equal(calls, 6);
});

test('catalog reuse has bounded document and byte budgets and every transaction retry starts fresh', async () => {
  let calls = 0;
  let revision = 1;
  const read = async (_collection: string, id: string) => {
    calls++;
    return { _id: id, revision, value: 'x'.repeat(250 * 1024) };
  };
  const first = createCatalogTransactionReads(read);
  for (let i = 0; i < 20; i++) await first.get('images', String(i));
  await first.get('images', '0');
  assert.equal(calls, 20);
  await first.get('images', '19');
  await first.get('images', '19');
  assert.equal(calls, 22, 'Rows beyond the byte budget use actual reads');
  revision = 2;
  const retry = createCatalogTransactionReads(read);
  assert.equal((await retry.get('images', '0')).revision, 2);
  const small = createCatalogTransactionReads(async (_collection, id) => {
    calls++;
    return { _id: id };
  });
  for (let i = 0; i < 110; i++) await small.get('images', String(i));
  const before = calls;
  await small.get('images', '0');
  assert.equal(calls, before);
  await small.get('images', '109');
  await small.get('images', '109');
  assert.equal(calls, before + 2, 'Rows beyond the document budget use actual reads');
});
