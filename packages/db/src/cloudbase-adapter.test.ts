import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  claimAlibabaSyncRunInCloudBase,
  preparingProductHiddenWhere,
  unclassifiedProductWhere,
  updateDocWithAlibabaLeaseInCloudBase,
  upsertCatalogSourceObservationInCloudBase,
  upsertDocWithAlibabaLeaseInCloudBase,
  wxRemovedCount,
} from './cloudbase-adapter.ts';

test('unclassified native query includes absent families without capturing legacy headphone categories', () => {
  const query = unclassifiedProductWhere({
    and: (items) => ({ $and: items }),
    or: (items) => ({ $or: items }),
    exists: (value) => ({ $exists: value }),
    nin: (values) => ({ $nin: values }),
  });
  assert.deepEqual(query, {
    $and: [
      { productFamily: { $nin: ['headphones', 'ai-gadgets', 'toys', 'misc'] } },
      {
        $or: [
          { productFamily: { $exists: true } },
          { category: { $nin: ['wired', 'office', 'bluetooth'] } },
        ],
      },
    ],
  });
});

test('drafts waiting for photos are hidden explicitly, whether or not the field exists (PT-G)', () => {
  const query = preparingProductHiddenWhere({
    or: (items) => ({ $or: items }),
    exists: (value) => ({ $exists: value }),
    neq: (value) => ({ $ne: value }),
  });
  assert.deepEqual(query, {
    $or: [{ alibabaPhotosPending: { $exists: false } }, { alibabaPhotosPending: { $ne: true } }],
  });
});

function fakeDatabase(initial: Record<string, CollectionDoc[]>) {
  const store = new Map<string, Map<string, CollectionDoc>>(
    Object.entries(initial).map(([name, docs]) => [
      name,
      new Map(docs.map((doc) => [doc._id, structuredClone(doc)])),
    ]),
  );
  const controls = {
    failWrite: '',
    silentWrite: '',
    codedWrite: '',
    wrongUpsertId: '',
    maximumOperations: 0,
  };
  type Scope = typeof store;
  const collection = (name: string, scope: Scope = store) => ({
    doc: (id: string) => ({
      get: async () => ({ data: structuredClone(scope.get(name)?.get(id) ?? null) }),
      update: async (patch: Record<string, unknown>) => {
        if (controls.failWrite === `${name}/${id}`) throw new Error('injected write failure');
        if (controls.silentWrite === `${name}/${id}`) return { updated: 0 };
        if (controls.codedWrite === `${name}/${id}`)
          return { code: 'DATABASE_TRANSACTION_CONFLICT' };
        const docs = scope.get(name) ?? new Map<string, CollectionDoc>();
        const existing = docs.get(id);
        if (!existing) return { updated: 0 };
        docs.set(id, { ...existing, ...patch });
        scope.set(name, docs);
        return { updated: 1 };
      },
      set: async (data: Record<string, unknown>) => {
        if (controls.failWrite === `${name}/${id}`) throw new Error('injected write failure');
        if (controls.silentWrite === `${name}/${id}`) return { updated: 0 };
        if (controls.codedWrite === `${name}/${id}`)
          return { code: 'DATABASE_TRANSACTION_CONFLICT' };
        const docs = scope.get(name) ?? new Map<string, CollectionDoc>();
        const exists = docs.has(id);
        docs.set(id, { _id: id, ...data });
        scope.set(name, docs);
        return exists
          ? { updated: 1 }
          : { upserted: [{ _id: controls.wrongUpsertId === `${name}/${id}` ? 'wrong-id' : id }] };
      },
      remove: async () => ({ deleted: 1 }),
    }),
  });
  return {
    store,
    controls,
    db: {
      command: { set: (value: unknown) => value },
      runTransaction: async <T>(
        operation: (transaction: { collection: typeof collection }) => Promise<T>,
      ) => {
        const copy = structuredClone(store);
        let writing = false;
        let operations = 0;
        const trackedCollection = (name: string) => ({
          doc: (id: string) => {
            const ref = collection(name, copy).doc(id);
            return {
              get: async () => {
                operations++;
                assert.equal(writing, false, 'all transaction reads precede writes');
                return ref.get();
              },
              update: async (data: Record<string, unknown>) => {
                operations++;
                writing = true;
                return ref.update(data);
              },
              set: async (data: Record<string, unknown>) => {
                operations++;
                writing = true;
                return ref.set(data);
              },
              remove: async () => {
                operations++;
                writing = true;
                return ref.remove();
              },
            };
          },
        });
        try {
          const result = await operation({ collection: trackedCollection });
          store.clear();
          for (const [name, docs] of copy) store.set(name, docs);
          return result;
        } finally {
          controls.maximumOperations = Math.max(controls.maximumOperations, operations);
        }
      },
    },
  };
}

test('production fenced upsert rejects a holder after lease takeover', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'new-holder',
        fence: 4,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    catalogSourceObservations: [{ _id: 'obs-1', active: false }],
  });

  const applied = await upsertDocWithAlibabaLeaseInCloudBase(
    harness.db,
    'catalogSourceObservations',
    'obs-1',
    { active: true },
    { firstSeenOperationId: 'run-old' },
    { connectionId: 'primary', holder: 'old-holder', fence: 3, now: at },
  );
  assert.equal(applied, false);
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.active, false);
});

test('production fenced upsert applies for the current lease holder', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'current-holder',
        fence: 4,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    catalogSourceObservations: [],
  });

  const applied = await upsertDocWithAlibabaLeaseInCloudBase(
    harness.db,
    'catalogSourceObservations',
    'obs-1',
    { active: true },
    { firstSeenOperationId: 'run-current' },
    { connectionId: 'primary', holder: 'current-holder', fence: 4, now: at },
  );
  assert.equal(applied, true);
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'run-current',
  );
});

test('production atomic run claim rejects a stale holder without creating an orphan run', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'new-holder',
        fence: 9,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    alibabaSyncCheckpoints: [{ _id: 'primary', activeRunId: '' }],
    alibabaSyncRuns: [],
  });

  const result = await claimAlibabaSyncRunInCloudBase(
    harness.db,
    'run-old',
    { status: 'running' },
    { activeRunId: 'run-old' },
    { connectionId: 'primary', holder: 'old-holder', fence: 8, now: at },
  );
  assert.equal(result, 'lease-lost');
  assert.equal(harness.store.get('alibabaSyncRuns')?.size, 0);
  assert.equal(harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId, '');
});

test('production atomic run claim creates the run and claims its checkpoint together', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'current-holder',
        fence: 9,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    alibabaSyncCheckpoints: [{ _id: 'primary', activeRunId: '' }],
    alibabaSyncRuns: [],
  });

  const result = await claimAlibabaSyncRunInCloudBase(
    harness.db,
    'run-current',
    { _id: 'forged-run-id', status: 'running' },
    { _id: 'forged-checkpoint-id', activeRunId: 'run-current', stage: 'enumerate' },
    { connectionId: 'primary', holder: 'current-holder', fence: 9, now: at },
  );
  assert.equal(result, 'claimed');
  assert.deepEqual(harness.store.get('alibabaSyncRuns')?.get('run-current'), {
    _id: 'run-current',
    status: 'running',
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(
    harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId,
    'run-current',
  );
});

test('production source observation upsert rejects older captures and preserves first-seen provenance', async () => {
  const harness = fakeDatabase({
    catalogSourceObservations: [
      {
        _id: 'obs-1',
        observedAt: '2026-09-04T10:00:00.000Z',
        title: 'newer',
        firstSeenOperationId: 'first-import',
      },
    ],
  });

  const stale = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'obs-1',
    { observedAt: '2026-09-04T09:00:00.000Z', title: 'older' },
    { firstSeenOperationId: 'wrong-import' },
    '2026-09-04T10:01:00.000Z',
  );
  assert.equal(stale.result, 'stale');
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.title, 'newer');
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'first-import',
  );

  const applied = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'obs-1',
    { observedAt: '2026-09-04T11:00:00.000Z', title: 'newest' },
    { firstSeenOperationId: 'wrong-import' },
    '2026-09-04T11:01:00.000Z',
  );
  assert.equal(applied.result, 'applied');
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.title, 'newest');
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'first-import',
  );
});

test('a wx-server-sdk delete reports its count under stats.removed, not deleted', () => {
  // The shape wx-server-sdk 4.0.2 resolves (index.js `remove`); reading
  // `deleted` made every successful admin delete answer "not found".
  assert.equal(wxRemovedCount({ stats: { removed: 1 } }), 1);
  assert.equal(wxRemovedCount({ stats: { removed: 0 } }), 0);
  assert.equal(wxRemovedCount({ deleted: 1 } as never), 0, 'node-sdk shape is not what wx returns');
  assert.equal(wxRemovedCount(undefined), 0);
});

for (const writer of ['fenced-upsert', 'generic-upsert'] as const) {
  test(`source change atomically invalidates the linked preparation through ${writer}`, async () => {
    const at = '2026-10-13T00:00:00.000Z';
    const source = {
      _id: 'observation',
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      active: true,
      observedAt: at,
      observation: {
        source: { provider: 'alibaba', sourceProductKey: 'source-a', observedAt: at },
        identity: { title: 'Before' },
      },
    };
    const live = {
      _id: 'product',
      name: 'Website',
      alibabaPrimarySourceKey: 'source-a',
      detailSourceReady: true,
      published: true,
      productFamily: 'misc',
      catalogDetailPublication: { revision: 'old-approved' },
    };
    const harness = fakeDatabase({
      alibabaSyncLeases: [
        {
          _id: 'primary',
          holder: 'holder',
          fence: 1,
          acquiredAt: at,
          heartbeatAt: at,
          expiresAt: '2026-10-13T00:03:00.000Z',
          releasedAt: '',
        },
      ],
      catalogSourceObservations: [source],
      alibabaProductLinks: [{ _id: 'source-a', sourceKey: 'source-a', productId: 'product' }],
      products: [live],
    });
    const patch = {
      ...source,
      observation: { ...source.observation, identity: { title: 'After' } },
    };
    if (writer === 'fenced-upsert')
      await upsertDocWithAlibabaLeaseInCloudBase(
        harness.db,
        'catalogSourceObservations',
        source._id,
        patch,
        {},
        { connectionId: 'primary', holder: 'holder', fence: 1, now: at },
      );
    else await upsertCatalogSourceObservationInCloudBase(harness.db, source._id, patch, {}, at);
    const product = harness.store.get('products')?.get('product');
    assert.equal(product?.detailSourceReady, false);
    assert.equal(product?.catalogContentGeneration, 1);
    assert.equal(product?.published, true);
    assert.equal(product?.productFamily, 'misc');
    assert.deepEqual(product?.catalogDetailPublication, live.catalogDetailPublication);
  });
}

for (const writer of ['fenced-upsert', 'generic-upsert', 'fenced-tombstone'] as const) {
  for (const fault of [
    'source-failure',
    'product-failure',
    'silent-source',
    'silent-product',
  ] as const) {
    test(`source invalidation rolls back both documents: ${writer}/${fault}`, async () => {
      const at = '2026-10-13T00:00:00.000Z';
      const observation = {
        _id: 'obs',
        provider: 'alibaba',
        sourceProductKey: 'key',
        observedAt: at,
        active: true,
        observation: {
          source: { provider: 'alibaba', sourceProductKey: 'key' },
          identity: { title: 'Before' },
        },
      };
      const harness = fakeDatabase({
        alibabaSyncLeases: [
          {
            _id: 'primary',
            holder: 'holder',
            fence: 1,
            acquiredAt: at,
            heartbeatAt: at,
            expiresAt: '2026-10-13T00:03:00.000Z',
            releasedAt: '',
          },
        ],
        catalogSourceObservations: [observation],
        alibabaProductLinks: [{ _id: 'key', sourceKey: 'key', productId: 'p' }],
        products: [
          { _id: 'p', alibabaPrimarySourceKey: 'key', detailSourceReady: true, published: true },
        ],
      });
      const before = structuredClone(harness.store);
      const target = fault.includes('source') ? 'catalogSourceObservations/obs' : 'products/p';
      if (fault.startsWith('silent')) harness.controls.silentWrite = target;
      else harness.controls.failWrite = target;
      const guard = { connectionId: 'primary', holder: 'holder', fence: 1, now: at };
      const patch = {
        ...observation,
        observation: { ...observation.observation, identity: { title: 'After' } },
      };
      const write = () =>
        writer === 'fenced-upsert'
          ? upsertDocWithAlibabaLeaseInCloudBase(
              harness.db,
              'catalogSourceObservations',
              'obs',
              patch,
              {},
              guard,
            )
          : writer === 'fenced-tombstone'
            ? updateDocWithAlibabaLeaseInCloudBase(
                harness.db,
                'catalogSourceObservations',
                'obs',
                { active: false },
                guard,
              )
            : upsertCatalogSourceObservationInCloudBase(harness.db, 'obs', patch, {}, at);
      await assert.rejects(write(), /write failure|not confirmed/);
      assert.deepEqual(harness.store, before);
      harness.controls.failWrite = '';
      harness.controls.silentWrite = '';
      await write();
      assert.equal(harness.store.get('products')?.get('p')?.detailSourceReady, false);
      assert.ok(harness.controls.maximumOperations <= (writer === 'generic-upsert' ? 5 : 7));
    });
  }
}

test('Cloud observation recapture cannot overwrite its private binding fence', async () => {
  const at = '2026-10-14T00:00:00.000Z';
  const harness = fakeDatabase({
    catalogSourceObservations: [
      { _id: 'o', active: true, observedAt: at, catalogBindingGeneration: 3 },
    ],
  });
  const result = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'o',
    { active: true, observedAt: at, catalogBindingGeneration: 1 },
    {},
    at,
  );
  assert.equal(result.doc.catalogBindingGeneration, 3);
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('o')?.catalogBindingGeneration,
    3,
  );
});

for (const action of ['upsert', 'update'] as const) {
  for (const failure of ['throw', 'silent'] as const) {
    test(`lease fence ${failure} prevents ${action} and releases the owner queue`, async () => {
      const at = '2026-10-14T00:00:00.000Z';
      const harness = fakeDatabase({
        alibabaSyncLeases: [
          {
            _id: 'primary',
            holder: 'owner',
            fence: 1,
            expiresAt: '2026-10-14T00:03:00.000Z',
            releasedAt: '',
          },
        ],
        alibabaSupplierOffers: [{ _id: 'offer', value: 'before' }],
      });
      const before = structuredClone(harness.store);
      if (failure === 'throw') harness.controls.failWrite = 'alibabaSyncLeases/primary';
      else harness.controls.silentWrite = 'alibabaSyncLeases/primary';
      const guard = { connectionId: 'primary', holder: 'owner', fence: 1, now: at };
      const write = () =>
        action === 'upsert'
          ? upsertDocWithAlibabaLeaseInCloudBase(
              harness.db,
              'alibabaSupplierOffers',
              'offer',
              { value: 'after' },
              {},
              guard,
            )
          : updateDocWithAlibabaLeaseInCloudBase(
              harness.db,
              'alibabaSupplierOffers',
              'offer',
              { value: 'after' },
              guard,
            );
      await assert.rejects(write(), /write failure|not confirmed/);
      assert.deepEqual(harness.store, before);
      harness.controls.failWrite = '';
      harness.controls.silentWrite = '';
      assert.equal(await write(), true);
      assert.equal(harness.store.get('alibabaSupplierOffers')?.get('offer')?.value, 'after');
    });
  }
}

function writeAckFixture(collection: string, existing = true) {
  const at = '2026-10-14T00:00:00.000Z';
  return {
    at,
    harness: fakeDatabase({
      alibabaSyncLeases: [
        {
          _id: 'primary',
          holder: 'ack-owner',
          fence: 1,
          expiresAt: '2026-10-14T00:03:00.000Z',
          releasedAt: '',
        },
      ],
      [collection]: existing ? [{ _id: 'target', value: 'before', updatedAt: at }] : [],
    }),
    guard: { connectionId: 'primary', holder: 'ack-owner', fence: 1, now: at },
  };
}

for (const collection of [
  'alibabaSupplierOffers',
  'alibabaRawReplayManifests',
  'alibabaSyncRuns',
  'alibabaSyncCheckpoints',
]) {
  for (const action of ['create', 'upsert', 'update'] as const) {
    for (const fault of ['zero', 'coded'] as const) {
      test(`${collection} ${action} rejects ${fault} business write ACK and rolls back lease transaction`, async () => {
        const { harness, guard } = writeAckFixture(collection, action !== 'create');
        const before = structuredClone(harness.store);
        if (fault === 'zero') harness.controls.silentWrite = `${collection}/target`;
        else harness.controls.codedWrite = `${collection}/target`;
        const write = () =>
          action === 'update'
            ? updateDocWithAlibabaLeaseInCloudBase(
                harness.db,
                collection,
                'target',
                { value: 'after' },
                guard,
              )
            : upsertDocWithAlibabaLeaseInCloudBase(
                harness.db,
                collection,
                'target',
                { value: 'after' },
                {},
                guard,
              );
        if (fault === 'zero') await assert.rejects(write(), /not confirmed/);
        else
          await assert.rejects(
            write(),
            (error) =>
              typeof error === 'object' &&
              error !== null &&
              Reflect.get(error, 'code') === 'DATABASE_TRANSACTION_CONFLICT',
          );
        assert.deepEqual(harness.store, before);
        harness.controls.silentWrite = '';
        harness.controls.codedWrite = '';
        assert.equal(await write(), true);
        assert.equal(harness.store.get(collection)?.get('target')?.value, 'after');
      });
    }
  }
  test(`${collection} refuses a new row ACK naming another identity`, async () => {
    const { harness, guard } = writeAckFixture(collection, false);
    harness.controls.wrongUpsertId = `${collection}/target`;
    const before = structuredClone(harness.store);
    await assert.rejects(
      upsertDocWithAlibabaLeaseInCloudBase(
        harness.db,
        collection,
        'target',
        { value: 'after' },
        {},
        guard,
      ),
      /not confirmed/,
    );
    assert.deepEqual(harness.store, before);
  });
}

for (const target of ['alibabaSyncRuns/new-run', 'alibabaSyncCheckpoints/primary']) {
  test(`run claim cannot succeed when ${target} was not written`, async () => {
    const { harness, guard } = writeAckFixture('unused', false);
    harness.store.set(
      'alibabaSyncCheckpoints',
      new Map([['primary', { _id: 'primary', activeRunId: '' }]]),
    );
    harness.controls.silentWrite = target;
    const before = structuredClone(harness.store);
    const write = () =>
      claimAlibabaSyncRunInCloudBase(
        harness.db,
        'new-run',
        { status: 'running' },
        { activeRunId: 'new-run' },
        guard,
      );
    await assert.rejects(write(), /not confirmed/);
    assert.deepEqual(harness.store, before);
    harness.controls.silentWrite = '';
    assert.equal(await write(), 'claimed');
    assert.equal(harness.store.get('alibabaSyncRuns')?.get('new-run')?.status, 'running');
    assert.equal(
      harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId,
      'new-run',
    );
  });
}

test('an unchanged generic target succeeds without requiring a redundant write ACK', async () => {
  const { harness, guard } = writeAckFixture('alibabaSupplierOffers');
  harness.controls.silentWrite = 'alibabaSupplierOffers/target';
  const before = structuredClone(harness.store);
  assert.equal(
    await updateDocWithAlibabaLeaseInCloudBase(
      harness.db,
      'alibabaSupplierOffers',
      'target',
      { value: 'before' },
      guard,
    ),
    true,
  );
  assert.deepEqual(harness.store, before);
  assert.equal(harness.controls.maximumOperations, 2);
});
