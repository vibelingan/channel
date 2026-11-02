import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createDeliveryStore, type DeliveryDatabase } from './delivery-store.ts';
import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';

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
  const transactions: NodeSdkDatabase['runTransaction'] = async (operation) =>
    operation({
      collection: () => ({
        doc: () => ({
          get: async () => read as { data: unknown },
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
