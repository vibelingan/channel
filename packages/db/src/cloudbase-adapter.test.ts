import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import {
  claimAlibabaSyncRunInCloudBase,
  manageCatalogPreparationJobInCloudBase,
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
        return controls.wrongUpsertId === `${name}/${id}`
          ? { upserted: [{ _id: 'wrong-id' }] }
          : exists ? { updated: 1 } : { upserted: [{ _id: id }] };
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


test('preparation cloud wrapper shares the transaction and confirms its deterministic write', async () => {
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [{ _id: 'p', name: 'Clock' }],
  });
  const now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'cloud-wrapper-test',
    environmentId: 'test',
    now: () => now,
  });
  const start = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    now,
  );
  assert.ok(start.ok && 'progress' in start);
  const replay = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    now,
  );
  assert.deepEqual(replay, start);
  const call = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'dispatch', actorId: 'admin', jobId: start.progress.jobId },
    now,
  );
  assert.ok(call.ok && 'call' in call);
  const claimed = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'claim', call: call.call, owner: 'worker' },
    now,
  );
  assert.ok(claimed.ok && 'lease' in claimed);
  assert.equal(claimed.progress.leaseVersion, 1);
  assert.ok(f.controls.maximumOperations <= 4);
  assert.deepEqual(f.store.get('products')?.get('p'), { _id: 'p', name: 'Clock' });
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const) {
  test(`preparation cloud wrapper rejects ${failure} and rolls back the transaction`, async () => {
    const f = fakeDatabase({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [{ _id: 'p', name: 'Clock' }],
    });
    const now = 1792080000000;
    const authority = createCatalogPreparationAuthority({
      secret: 'cloud-wrapper-test',
      environmentId: 'test',
      now: () => now,
    });
    const started = await manageCatalogPreparationJobInCloudBase(
      f.db,
      authority,
      { action: 'start', actorId: 'admin', productId: 'p' },
      now,
    );
    assert.ok(started.ok && 'progress' in started);
    const jobId = started.progress.jobId;
    const before = structuredClone(f.store);
    if (failure === 'wrongUpsertId') {
      f.store.get('catalogPreparationJobs')?.delete(jobId);
      f.controls.wrongUpsertId = `catalogPreparationJobs/${jobId}`;
      const empty = structuredClone(f.store);
      await assert.rejects(
        manageCatalogPreparationJobInCloudBase(
          f.db,
          authority,
          { action: 'start', actorId: 'admin', productId: 'p' },
          now,
        ),
      );
      assert.deepEqual(f.store, empty);
    } else {
      f.controls[failure] = `catalogPreparationJobs/${jobId}`;
      await assert.rejects(
        manageCatalogPreparationJobInCloudBase(
          f.db,
          authority,
          { action: 'cancel', actorId: 'admin', jobId, expectedLeaseVersion: 0 },
          now,
        ),
      );
      assert.deepEqual(f.store, before);
    }
  });
}

test('preparation cloud transaction callback uses a fresh clock after queue delay and retry', async (t) => {
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [{ _id: 'p', name: 'Clock' }],
  });
  let clock = 1792080000000;
  t.mock.method(Date, 'now', () => clock);
  const authority = createCatalogPreparationAuthority({
    secret: 'cloud-wrapper-test',
    environmentId: 'test',
    now: () => clock,
  });
  const db = {
    runTransaction: async <T>(operation: Parameters<typeof f.db.runTransaction<T>>[0]) => {
      const before = structuredClone(f.store);
      clock += 6000;
      await f.db.runTransaction(operation);
      f.store.clear();
      for (const [name, rows] of before) f.store.set(name, rows);
      clock += 6000;
      return f.db.runTransaction(operation);
    },
  };
  const result = await manageCatalogPreparationJobInCloudBase(db, authority, {
    action: 'start',
    actorId: 'admin',
    productId: 'p',
  });
  assert.ok(result.ok && 'progress' in result);
  assert.equal(result.progress.createdAt, new Date(clock).toISOString());
  assert.equal(f.store.get('catalogPreparationJobs')?.size, 1);
});


async function observationCloudFixture(withSource = false) {
  const image: CollectionDoc = {
    _id: 'image',
    status: 'active',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storageFileId: 'cloud://test/image.png',
    mimeType: 'image/png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 0,
  };
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [{ _id: 'p', name: 'Clock', imageIds: ['image'], ...(withSource ? { alibabaPrimarySourceKey: 'source' } : {}) }],
    ...(withSource ? { alibabaSourceProducts: [{ _id: 'source', sourceTitle: 'Source clock' }] } : {}),
    images: [image],
  });
  const now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'observation-wrapper-test',
    environmentId: 'test',
    now: () => now,
  });
  const started = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    now,
  );
  assert.ok(started.ok && 'progress' in started);
  const jobId = started.progress.jobId;
  const call = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'dispatch', actorId: 'admin', jobId },
    now,
  );
  assert.ok(call.ok && 'call' in call);
  const claimed = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'claim', call: call.call, owner: 'worker' },
    now,
  );
  assert.ok(claimed.ok && 'lease' in claimed);
  const imageInputDigest = storedCatalogImageInputDigest(image);
  const command = {
    action: 'put-image-check' as const,
    jobId,
    lease: claimed.lease,
    imageId: 'image',
    imageInputDigest,
    health: {
      status: 'verified' as const,
      kind: 'stored-image-health-v1' as const,
      imageId: 'image',
      inputDigest: imageInputDigest,
      byteSize: 123,
      checksumSha256: 'a'.repeat(64),
      width: 24,
      height: 16,
      pages: 1,
    },
  };
  const put = () => manageCatalogPreparationJobInCloudBase(f.db, authority, command, now);
  return { ...f, put, jobId, authority, command, now };
}
test('cloud observation transaction reads before both fenced writes and fits its operation budget', async () => {
  const f = await observationCloudFixture();
  const saved = await f.put();
  assert.ok(saved.ok && 'observation' in saved && saved.observation);
  assert.equal(f.controls.maximumOperations, 6);
  assert.equal(f.store.get('catalogPreparationJobs')?.get(f.jobId)?.mutationRevision, 2);
  assert.equal(f.store.get('catalogImageObservations')?.size, 1);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const) {
  test(`cloud ${failure} on observation write rolls back its prior job fence as well`, async () => {
    const f = await observationCloudFixture(),
      before = structuredClone(f.store),
      saved = await f.put();
    assert.ok(saved.ok && 'observation' in saved && saved.observation);
    const id = saved.observation._id;
    f.store.clear();
    for (const [name, rows] of before) f.store.set(name, rows);
    f.controls[failure] = `catalogImageObservations/${id}`;
    await assert.rejects(f.put());
    assert.deepEqual(f.store, before);
  });
}


test('source-backed image observation remains bounded to nine actual transaction operations', async () => {
  const f = await observationCloudFixture(true);
  const saved = await f.put();assert.ok(saved.ok && 'observation' in saved && saved.observation);
  assert.equal(f.controls.maximumOperations, 9);
});


test('cloud media cursor and observation commit together within nine source-backed operations', async () => {
  const f = await observationCloudFixture(true);
  const planDigest = 'b'.repeat(64);
  const run = (command: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
    manageCatalogPreparationJobInCloudBase(f.db, f.authority, command, f.now);
  assert.ok(
    (
      await run({
        action: 'bind-media-plan',
        jobId: f.jobId,
        lease: f.command.lease,
        planDigest,
        total: 1,
      })
    ).ok,
  );
  const step = { ...f.command, action: 'advance-media-check' as const, planDigest, index: 0 };
  const result = await run(step);
  assert.ok(result.ok && 'media' in result);
  assert.equal(result.media.cursor, 1);
  assert.equal(f.controls.maximumOperations, 9);
  const before = structuredClone(f.store);
  assert.deepEqual(await run(step), result);
  assert.deepEqual(f.store, before);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  test(`cloud ${failure} rolls back both media cursor and observation`, async () => {
    const f = await observationCloudFixture(true);
    const planDigest = 'b'.repeat(64);
    const run = (command: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
      manageCatalogPreparationJobInCloudBase(f.db, f.authority, command, f.now);
    await run({
      action: 'bind-media-plan',
      jobId: f.jobId,
      lease: f.command.lease,
      planDigest,
      total: 1,
    });
    const before = structuredClone(f.store);
    const step = { ...f.command, action: 'advance-media-check' as const, planDigest, index: 0 };
    assert.ok((await run(step)).ok);
    const observationId = f.store.get('catalogImageObservations')?.keys().next().value;
    assert.equal(typeof observationId, 'string');
    f.store.clear();
    for (const [name, rows] of before) f.store.set(name, rows);
    f.controls[failure] = `catalogImageObservations/${observationId}`;
    await assert.rejects(run(step));
    assert.deepEqual(f.store, before);
  });

async function protectionCloudFixture() {
  const f = await observationCloudFixture(true);
  const run = (cmd: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
    manageCatalogPreparationJobInCloudBase(f.db, f.authority, cmd, f.now);
  const scope = { jobId: f.jobId, lease: f.command.lease };
  const begun = await run({
    action: 'begin-image-protection',
    ...scope,
    imageId: 'image',
    imageInputDigest: f.command.imageInputDigest,
  });
  assert.ok(begun.ok && 'protection' in begun);
  const intent = begun.protection;
  const path = catalogProtectedStoragePath(
    `${intent.imageIdentity}:${intent.checksumSha256}:${intent.attemptId}`,
    'original.png',
  );
  const target = {
    storageProvider: 'cloudbase-storage' as const,
    storageMode: 'classic-nosql-storage' as const,
    storageFileId: `cloud://test/${path}`,
    storagePath: path,
    byteSize: 123,
  };
  const checkpoint = () =>
    run({
      action: 'checkpoint-image-protection',
      ...scope,
      imageId: 'image',
      intentId: intent._id,
      target,
    });
  const image = f.store.get('images')?.get('image');
  assert.ok(image);
  const health = {
    ...f.command.health,
    inputDigest: storedCatalogImageInputDigest({ ...image, ...target }),
  };
  const commit = () =>
    run({
      action: 'commit-image-protection',
      ...scope,
      imageId: 'image',
      intentId: intent._id,
      health,
    });
  return { ...f, run, scope, intent, target, checkpoint, commit };
}
test('source-backed protection reserves and commits with ten read-before-write operations, preserving counters', async () => {
  const f = await protectionCloudFixture();
  assert.equal(f.controls.maximumOperations, 10);
  assert.ok((await f.checkpoint()).ok);
  const before = structuredClone(f.store.get('products'));
  const committed = await f.commit();
  assert.ok(committed.ok && 'protection' in committed);
  assert.equal(committed.protection.state, 'committed');
  assert.equal(f.controls.maximumOperations, 10);
  assert.equal(f.store.get('images')?.get('image')?.storageFileId, f.target.storageFileId);
  assert.deepEqual(f.store.get('products'), before);
  const snapshot = structuredClone(f.store);
  assert.deepEqual(await f.commit(), committed);
  assert.deepEqual(f.store, snapshot);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const child of ['catalogImageObservations', 'images'] as const)
    test(`cloud protection ${failure} on ${child} rolls back target, journal and job fence`, async () => {
      const f = await protectionCloudFixture();
      await f.checkpoint();
      const before = structuredClone(f.store);
      f.controls[failure] = `${child}/${child === 'images' ? 'image' : f.intent._id}`;
      await assert.rejects(f.commit());
      assert.deepEqual(f.store, before);
    });

async function protectedPixelCloudFixture() {
  const f = await protectionCloudFixture();
  await f.checkpoint();
  assert.ok((await f.commit()).ok);
  const image = f.store.get('images')?.get('image');
  assert.ok(image);
  const health = { ...f.command.health, inputDigest: storedCatalogImageInputDigest(image) };
  const planDigest = 'e'.repeat(64);
  assert.ok((await f.run({ action: 'bind-media-plan', ...f.scope, planDigest, total: 1 })).ok);
  const step = {
    action: 'advance-media-check' as const,
    ...f.scope,
    planDigest,
    index: 0,
    imageId: 'image',
    imageInputDigest: health.inputDigest,
    health,
  };
  return { ...f, health, step };
}
test('protected source-backed pixel receipt, observation and cursor share twelve read-before-write operations', async () => {
  const f = await protectedPixelCloudFixture();
  assert.ok((await f.run(f.step)).ok);
  assert.equal(f.controls.maximumOperations, 12);
  const before = structuredClone(f.store);
  assert.deepEqual(
    await f.run({ action: 'get-protected-image-health', ...f.scope, imageId: 'image' }),
    { ok: true, protectedHealth: f.health },
  );
  assert.deepEqual(f.store, before);
  assert.ok((await f.run(f.step)).ok);
  assert.deepEqual(f.store, before);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  test(`pixel receipt ${failure} rolls back job, observation and cursor`, async () => {
    const f = await protectedPixelCloudFixture();
    const before = structuredClone(f.store);
    assert.ok((await f.run(f.step)).ok);
    const cache = [...(f.store.get('catalogImageObservations')?.values() ?? [])].find(
      (r) => r.kind === 'catalog-protected-image-health-v1',
    );
    assert.ok(cache);
    f.store.clear();
    for (const [name, rows] of before) f.store.set(name, rows);
    f.controls[failure] = `catalogImageObservations/${cache._id}`;
    await assert.rejects(f.run(f.step));
    assert.deepEqual(f.store, before);
  });
