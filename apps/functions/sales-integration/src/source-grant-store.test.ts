import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import { createCloudBaseSourceGrantStore } from './source-grant-store.ts';

function sdkFixture() {
  let data: unknown = [{ _id: 'one', record: { state: 'active' } }];
  let code: string | undefined;
  let error = false;
  let acknowledgement: {
    updated?: number;
    upserted?: Array<{ _id?: string }>;
    code?: string;
    error?: string;
  } = { upserted: [{ _id: 'one' }] };
  const writes: Array<{
    collection: string;
    id: string;
    data: Record<string, unknown>;
  }> = [];
  const db: NodeSdkDatabase = {
    command: { set: (value) => value },
    runTransaction: (operation) =>
      operation({
        collection: (collection) => ({
          doc: (id) => ({
            get: async () => ({
              data,
              ...(code === undefined ? {} : { code }),
              ...(error ? { error: 'synthetic' } : {}),
            }),
            set: async (value) => {
              writes.push({ collection, id, data: value });
              return acknowledgement;
            },
            update: async () => {
              throw new Error('unused');
            },
            remove: async () => {
              throw new Error('unused');
            },
          }),
        }),
      }),
  };
  return {
    store: createCloudBaseSourceGrantStore(db),
    writes,
    setData: (value: unknown) => {
      data = value;
    },
    setCode: (value: string | undefined) => {
      code = value;
    },
    setError: (value: boolean) => {
      error = value;
    },
    setAcknowledgement: (value: typeof acknowledgement) => {
      acknowledgement = value;
    },
  };
}

test('CloudBase grant adapter returns transaction result and uses flat SDK doc.set data', async () => {
  const s = sdkFixture();
  const result = await s.store.transaction(async (tx) => {
    assert.deepEqual(await tx.read('channelSalesInstallations', 'one'), {
      _id: 'one',
      record: { state: 'active' },
    });
    await tx.write('channelSalesTaskLeases', 'one', {
      record: { marker: 'synthetic' },
    });
    return 'transaction-result';
  });
  assert.equal(result, 'transaction-result');
  assert.deepEqual(s.writes, [
    {
      collection: 'channelSalesTaskLeases',
      id: 'one',
      data: { record: { marker: 'synthetic' } },
    },
  ]);
});

test('CloudBase grant adapter never treats an SDK error envelope as a missing authority record', async () => {
  const s = sdkFixture();
  s.setData(undefined);
  await assert.rejects(s.store.transaction((tx) => tx.read('channelSalesSourceHandoffs', 'one')));
  s.setData(null);
  s.setCode('SYNTHETIC_PROVIDER_ERROR');
  await assert.rejects(s.store.transaction((tx) => tx.read('channelSalesSourceHandoffs', 'one')));
  s.setCode(undefined);
  s.setError(true);
  await assert.rejects(s.store.transaction((tx) => tx.read('channelSalesSourceHandoffs', 'one')));
  s.setError(false);
  assert.equal(
    await s.store.transaction((tx) => tx.read('channelSalesSourceHandoffs', 'one')),
    null,
  );
});

test('CloudBase grant adapter rejects ambiguous documents, unacknowledged writes and read-after-write', async () => {
  const s = sdkFixture();
  for (const data of [
    [{ _id: 'one' }, { _id: 'one' }],
    [null],
    [undefined],
    { _id: 'other' },
    {},
    'bad',
  ]) {
    s.setData(data);
    await assert.rejects(s.store.transaction((tx) => tx.read('channelSalesInstallations', 'one')));
  }
  s.setData([]);
  assert.equal(
    await s.store.transaction((tx) => tx.read('channelSalesInstallations', 'one')),
    null,
  );
  await assert.rejects(
    s.store.transaction((tx) => tx.write('channelSalesTaskLeases', 'one', { _id: 'one' })),
  );
  for (const acknowledgement of [
    { updated: 0, upserted: [] },
    { updated: 1, code: 'SYNTHETIC_ERROR' },
    { updated: 1, error: 'synthetic' },
  ]) {
    s.setAcknowledgement(acknowledgement);
    await assert.rejects(
      s.store.transaction((tx) => tx.write('channelSalesTaskLeases', 'one', { record: {} })),
    );
  }
  s.setAcknowledgement({ updated: 1 });
  await assert.rejects(
    s.store.transaction(async (tx) => {
      await tx.write('channelSalesTaskLeases', 'one', { record: {} });
      await tx.read('channelSalesInstallations', 'one');
    }),
  );
});
