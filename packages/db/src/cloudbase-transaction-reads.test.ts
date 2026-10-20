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
