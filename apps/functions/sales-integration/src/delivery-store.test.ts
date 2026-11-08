import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import { type DeliveryDatabase, createDeliveryStore } from './delivery-store.ts';
import { createCloudBaseSourceGrantStore } from './source-grant-store.ts';

const owner = {
  client_id: 'client_a',
  business_line: 'website_sales',
  source_installation_id: 'site_a',
  environment: 'test' as const,
};
function probe() {
  let read: unknown = { data: null };
  let scan: unknown = { data: [] };
  let acknowledgement: unknown = { updated: 1 };
  const calls: Array<[string, unknown]> = [];
  const reads: Array<[string, string]> = [];
  const transactions: NodeSdkDatabase['runTransaction'] = async (operation) =>
    operation({
      collection: (collection) => ({
        doc: (id) => ({
          get: async () => {
            reads.push([collection, id]);
            return read as { data: unknown };
          },
          set: async (data) => {
            calls.push(['set', data]);
            return acknowledgement as { updated?: number };
          },
          update: async () => ({}),
          remove: async () => ({}),
        }),
      }),
    });
  const query = {
    orderBy: (field: string, direction: string) => {
      calls.push(['orderBy', [field, direction]]);
      return query;
    },
    limit: (value: number) => {
      calls.push(['limit', value]);
      return query;
    },
    get: async () => scan,
  };
  const db: DeliveryDatabase = {
    runTransaction: transactions,
    command: { gt: (value) => ({ gt: value }), in: (values) => ({ in: values }) },
    collection: (name) => {
      calls.push(['collection', name]);
      return {
        where: (filters) => {
          calls.push(['where', filters]);
          return query;
        },
      };
    },
  };
  return {
    store: createDeliveryStore(db),
    calls,
    reads,
    setRead: (value: unknown) => {
      read = value;
    },
    setScan: (value: unknown) => {
      scan = value;
    },
    setAck: (value: unknown) => {
      acknowledgement = value;
    },
  };
}
test('scanner sends owner predicates, stable key cursor and bounded limit without offset', async () => {
  const p = probe();
  const cursor = 'a'.repeat(64);
  await p.store.scan(owner, cursor, 7);
  assert.deepEqual(p.calls, [
    ['collection', 'channelSalesSourceDeliveries'],
    [
      'where',
      {
        'record.client_id': 'client_a',
        'record.business_line': 'website_sales',
        'record.source_installation_id': 'site_a',
        'record.environment': 'test',
        'record.status': { in: ['pending', 'retry', 'inflight'] },
        _id: { gt: cursor },
      },
    ],
    ['orderBy', ['_id', 'asc']],
    ['limit', 7],
  ]);
});
test('SDK error envelopes are refused for scans, reads and writes', async () => {
  const p = probe();
  for (const invalid of [
    { code: 'SYNTHETIC' },
    { data: [], code: 'SYNTHETIC' },
    { data: null },
    { data: [{}] },
    { data: Array(51).fill({}) },
  ]) {
    p.setScan(invalid);
    await assert.rejects(p.store.scan(owner, null, 20));
  }
  p.setRead({ code: 'SYNTHETIC', data: null });
  await assert.rejects(p.store.transaction((tx) => tx.read('channelSalesSourceDeliveries', 'a')));
  p.setRead({ data: null });
  assert.equal(
    await p.store.transaction((tx) => tx.read('channelSalesSourceDeliveries', 'a')),
    null,
  );
  p.setAck({ code: 'SYNTHETIC', updated: 1 });
  await assert.rejects(
    p.store.transaction((tx) => tx.write('channelSalesSourceDeliveries', 'a', { record: {} })),
  );
});
test('flat SDK writes preserve transaction return and reads cannot follow writes', async () => {
  const p = probe();
  assert.equal(
    await p.store.transaction(async (tx) => {
      await tx.write('channelSalesSourceDeliveries', 'a', { record: { value: 1 } });
      return 42;
    }),
    42,
  );
  assert.deepEqual(p.calls, [['set', { record: { value: 1 } }]]);
  await assert.rejects(
    p.store.transaction(async (tx) => {
      await tx.write('channelSalesSourceDeliveries', 'a', {});
      return tx.read('channelSalesBindings', 'site_a');
    }),
    /read after write/,
  );
});

test('installed database SDK serializes the scoped active queue query without network', async () => {
  const localRequire = createRequire(
    new URL('../../../../packages/db/package.json', import.meta.url),
  );
  const sdkRequire = createRequire(localRequire.resolve('@cloudbase/node-sdk'));
  const installed: unknown = sdkRequire('@cloudbase/database');
  assert.ok(installed && typeof installed === 'object');
  const Constructor: unknown = Reflect.get(installed, 'Db');
  assert.ok(typeof Constructor === 'function');
  const original: unknown = Reflect.get(Constructor, 'reqClass');
  const wire: Array<{ method: unknown; payload: unknown }> = [];
  class OfflineRequest {
    async send(method: unknown, payload: unknown) {
      wire.push({ method, payload });
      return { data: { list: [] }, requestId: 'offline-probe' };
    }
  }
  Reflect.set(Constructor, 'reqClass', OfflineRequest);
  try {
    const value: unknown = Reflect.construct(Constructor, [
      { envName: 'offline-sales-query-probe' },
    ]);
    function databaseShape(candidate: unknown): candidate is DeliveryDatabase {
      if (!candidate || typeof candidate !== 'object') return false;
      const command: unknown = Reflect.get(candidate, 'command');
      return (
        typeof Reflect.get(candidate, 'collection') === 'function' &&
        typeof Reflect.get(candidate, 'runTransaction') === 'function' &&
        !!command &&
        typeof command === 'object' &&
        typeof Reflect.get(command, 'gt') === 'function' &&
        typeof Reflect.get(command, 'in') === 'function'
      );
    }
    assert.ok(databaseShape(value));
    await createDeliveryStore(value).scan(owner, 'a'.repeat(64), 7);
    assert.equal(wire.length, 1);
    assert.equal(wire[0]?.method, 'database.getDocument');
    const payload = wire[0]?.payload;
    assert.ok(payload && typeof payload === 'object');
    assert.equal(Reflect.get(payload, 'collectionName'), 'channelSalesSourceDeliveries');
    assert.equal(Reflect.get(payload, 'limit'), 7);
    assert.equal(Object.hasOwn(payload, 'offset'), false);
    assert.deepEqual(JSON.parse(String(Reflect.get(payload, 'order'))), {
      _id: { $numberInt: '1' },
    });
    assert.deepEqual(JSON.parse(String(Reflect.get(payload, 'query'))), {
      'record.client_id': 'client_a',
      'record.business_line': 'website_sales',
      'record.source_installation_id': 'site_a',
      'record.environment': 'test',
      'record.status': { $in: ['pending', 'retry', 'inflight'] },
      _id: { $gt: 'a'.repeat(64) },
    });
  } finally {
    Reflect.set(Constructor, 'reqClass', original);
  }
});

test('snapshot reuse avoids sequential and concurrent duplicate reads without sharing returned objects', async () => {
  const s = probe();
  s.setRead({ data: { _id: 'one', record: { state: 'active' } } });
  await s.store.transaction(async (tx) => {
    const first = await tx.read('channelSalesBindings', 'one');
    assert.ok(first && typeof first === 'object');
    const record: unknown = Reflect.get(first, 'record');
    assert.ok(record && typeof record === 'object');
    Reflect.set(record, 'state', 'changed by caller');
    const [second, third] = await Promise.all([
      tx.read('channelSalesBindings', 'one'),
      tx.read('channelSalesBindings', 'one'),
    ]);
    assert.deepEqual(second, { _id: 'one', record: { state: 'active' } });
    assert.deepEqual(third, second);
    assert.notEqual(second, third);
    assert.equal(s.reads.length, 1);
    await tx.read('channelSalesInstallations', 'one');
    assert.equal(s.reads.length, 2, 'Same ID in another collection is a different document');
  });
  s.setRead({ data: { _id: 'one', record: { state: 'revoked' } } });
  assert.deepEqual(await s.store.transaction((tx) => tx.read('channelSalesBindings', 'one')), {
    _id: 'one',
    record: { state: 'revoked' },
  });
  assert.equal(s.reads.length, 3, 'A new transaction must read current authority');
});

test('snapshot reuse includes missing documents and cannot bypass the write barrier', async () => {
  const s = probe();
  s.setRead({ data: null });
  await s.store.transaction(async (tx) => {
    assert.equal(await tx.read('channelSalesBindings', 'one'), null);
    assert.equal(await tx.read('channelSalesBindings', 'one'), null);
    assert.equal(s.reads.length, 1);
    await tx.write('channelSalesSourceDeliveries', 'one', { record: {} });
    await assert.rejects(tx.read('channelSalesBindings', 'one'), /read after write/);
    assert.equal(s.reads.length, 1, 'No cached or native read is allowed after a write');
  });
});

test('a failed transaction cannot supply cached authority to its retry', async () => {
  const s = probe();
  s.setRead({ data: null, code: 'SYNTHETIC_FAILURE' });
  await assert.rejects(s.store.transaction((tx) => tx.read('channelSalesBindings', 'one')));
  s.setRead({ data: { _id: 'one', record: { state: 'revoked' } } });
  assert.deepEqual(await s.store.transaction((tx) => tx.read('channelSalesBindings', 'one')), {
    _id: 'one',
    record: { state: 'revoked' },
  });
  assert.equal(s.reads.length, 2);
});

test('installed SDK conflict retries start both adapters with fresh transaction snapshots', async () => {
  const localRequire = createRequire(
    new URL('../../../../packages/db/package.json', import.meta.url),
  );
  const sdkRequire = createRequire(localRequire.resolve('@cloudbase/node-sdk'));
  const installed: unknown = sdkRequire('@cloudbase/database');
  assert.ok(installed && typeof installed === 'object');
  const Constructor: unknown = Reflect.get(installed, 'Db');
  assert.ok(typeof Constructor === 'function');
  const original: unknown = Reflect.get(Constructor, 'reqClass');
  let starts = 0;
  const reads: unknown[] = [];
  class OfflineRequest {
    async send(method: unknown, payload: unknown) {
      if (method === 'database.startTransaction') return { transactionId: `snapshot-${++starts}` };
      if (method === 'database.commitTransaction') {
        return starts === 1 ? { code: 'DATABASE_TRANSACTION_CONFLICT' } : {};
      }
      if (method === 'database.abortTransaction') return {};
      assert.equal(method, 'database.getDocument');
      assert.ok(payload && typeof payload === 'object');
      assert.equal(Reflect.get(payload, 'transactionId'), `snapshot-${starts}`);
      reads.push(payload);
      return {
        data: {
          list: [
            JSON.stringify({
              _id: 'one',
              record: {
                state: starts === 1 ? 'active' : 'revoked',
              },
            }),
          ],
        },
      };
    }
  }
  function databaseShape(value: unknown): value is DeliveryDatabase & NodeSdkDatabase {
    if (!value || typeof value !== 'object') return false;
    const command: unknown = Reflect.get(value, 'command');
    return (
      typeof Reflect.get(value, 'collection') === 'function' &&
      typeof Reflect.get(value, 'runTransaction') === 'function' &&
      !!command &&
      typeof command === 'object' &&
      ['gt', 'in', 'set'].every((key) => typeof Reflect.get(command, key) === 'function')
    );
  }
  Reflect.set(Constructor, 'reqClass', OfflineRequest);
  try {
    for (const factory of [createDeliveryStore, createCloudBaseSourceGrantStore]) {
      starts = 0;
      reads.length = 0;
      const db: unknown = Reflect.construct(Constructor, [
        { envName: 'offline-sales-retry-probe' },
      ]);
      assert.ok(databaseShape(db));
      let callbacks = 0;
      const result = await factory(db).transaction(async (tx) => {
        callbacks++;
        const first = await tx.read('channelSalesBindings', 'one');
        assert.deepEqual(await tx.read('channelSalesBindings', 'one'), first);
        return first;
      });
      assert.equal(callbacks, 2);
      assert.equal(reads.length, 2, 'Each native snapshot performs its own single read');
      assert.deepEqual(result, { _id: 'one', record: { state: 'revoked' } });
    }
  } finally {
    Reflect.set(Constructor, 'reqClass', original);
  }
});
